TESTFLIGHT_REVIEW_STATES = %w[WAITING_FOR_BETA_REVIEW IN_BETA_REVIEW].freeze
TESTFLIGHT_AVAILABLE_STATES = %w[READY_FOR_BETA_TESTING IN_BETA_TESTING].freeze

def ios_release_destination(value)
  destination = value.to_s.strip
  destination = "app-store" if destination.empty?
  UI.user_error!("Unsupported iOS release destination #{destination}.") unless %w[app-store testflight].include?(destination)
  destination
end

def preflight_testflight!(app:, expected_group_id: nil)
  group_id = ENV["OPENCLAW_TESTFLIGHT_GROUP_ID"].to_s.strip
  UI.user_error!("Set OPENCLAW_TESTFLIGHT_GROUP_ID to the existing external testing group's ID.") if group_id.empty?
  if expected_group_id && group_id != expected_group_id
    UI.user_error!("The TestFlight group changed after planning; restore the saved group before continuing.")
  end
  groups = app.get_beta_groups
  group = groups.find { |candidate| candidate.id == group_id }
  unless group && group.is_internal_group == false
    UI.user_error!("The configured TestFlight group must belong to this app and be external.")
  end
  # Pilot accepts both names and IDs. Prevent a second group's name from
  # broadening the requested ID into an unintended distribution target.
  if groups.any? { |candidate| candidate.id != group_id && candidate.name == group_id }
    UI.user_error!("The TestFlight group ID also names another group; resolve the ambiguous group name before distributing.")
  end
  localizations = app.get_beta_app_localizations.select { |localization| localization.locale == "en-US" }
  unless localizations.length == 1 && %i[description feedback_email].all? { |field| env_present?(localizations.first.public_send(field).to_s) }
    UI.user_error!("Complete the en-US TestFlight beta description and feedback email in App Store Connect.")
  end
  details = Spaceship::ConnectAPI.get_beta_app_review_detail(filter: { app: app.id }).all_pages.flat_map(&:to_models)
  required = %i[contact_first_name contact_last_name contact_email contact_phone notes]
  unless details.length == 1 && required.all? { |field| env_present?(details.first.public_send(field).to_s) }
    UI.user_error!("Complete the TestFlight review contact and reviewer instructions in App Store Connect.")
  end
  detail = details.first
  if detail.demo_account_required == true && %i[demo_account_name demo_account_password].any? { |field| !env_present?(detail.public_send(field).to_s) }
    UI.user_error!("TestFlight requires a demo account; complete its credentials in App Store Connect.")
  end
  group
end

def testflight_train_builds(app:, short_version:)
  Spaceship::ConnectAPI::Build.all(
    app_id: app.id, version: short_version, platform: Spaceship::ConnectAPI::Platform::IOS,
    includes: "preReleaseVersion,buildBetaDetail", limit: 200
  ).select { |build| build.processing_state == "VALID" && build.expired == false }
end

def testflight_build_facts(build, group_build_ids, store_build_ids)
  localizations = build.get_beta_build_localizations
  english = localizations.select { |localization| localization.locale == "en-US" }
  {
    "id" => build.id,
    "shortVersion" => build.app_version,
    "buildNumber" => build.version.to_s,
    "externalState" => build.build_beta_detail&.external_build_state,
    "hasBetaNotes" => localizations.any? { |localization| env_present?(localization.whats_new.to_s) },
    "selectedForAppStore" => store_build_ids.include?(build.id),
    "configured" => group_build_ids.include?(build.id) && build.build_beta_detail&.auto_notify_enabled == true &&
      english.length == 1 && env_present?(english.first.whats_new.to_s)
  }
end

def testflight_plan_facts(app:, group:, short_version:, versions:)
  group_build_ids = group.fetch_builds.map(&:id)
  store_build_ids = versions.select { |version| version.version_string == short_version }.filter_map { |version| version.get_build&.id }
  builds = testflight_train_builds(app: app, short_version: short_version).map { |build| testflight_build_facts(build, group_build_ids, store_build_ids) }
  pending = builds.select { |build| TESTFLIGHT_REVIEW_STATES.include?(build.fetch("externalState")) }
  UI.user_error!("Multiple TestFlight builds are in review for #{short_version}; reconcile App Store Connect before continuing.") if pending.length > 1
  { "groupId" => group.id, "builds" => builds, "pendingBuild" => pending.first }
end

def assert_testflight_upload_ready!(plan)
  frozen = JSON.parse(File.read(ENV.fetch("OPENCLAW_IOS_RELEASE_PLAN")))
  unless frozen.fetch("destination") == "testflight" && frozen.fetch("testflight").fetch("groupId") == plan.fetch("testflight").fetch("groupId")
    UI.user_error!("TestFlight destination or group changed after planning; start a new release attempt.")
  end
  pending = plan.fetch("testflight").fetch("pendingBuild")
  if pending
    UI.user_error!("TestFlight build #{pending.fetch("shortVersion")} (#{pending.fetch("buildNumber")}) is already awaiting review; no new upload was attempted.")
  end
end

def stage_ios_testflight_release!(api_key:, short_version:, build_number:, notes:)
  frozen = JSON.parse(File.read(ENV.fetch("OPENCLAW_IOS_RELEASE_PLAN")))
  unless frozen.fetch("destination") == "testflight" && frozen.fetch("appStoreVersion") == short_version && frozen.fetch("buildNumber").to_s == build_number
    UI.user_error!("TestFlight staging requires the exact saved release destination and build identity.")
  end
  app = app_store_connect_target_app
  group = preflight_testflight!(app: app, expected_group_id: frozen.fetch("testflight").fetch("groupId"))
  builds = testflight_train_builds(app: app, short_version: short_version)
  matches = builds.select { |build| build.version.to_s == build_number }
  UI.user_error!("Expected one valid, unexpired processed TestFlight build #{short_version} (#{build_number}); found #{matches.length}. No upload was attempted.") unless matches.length == 1
  build = matches.first
  state = build.build_beta_detail&.external_build_state
  pending = builds.find { |candidate| candidate.id != build.id && TESTFLIGHT_REVIEW_STATES.include?(candidate.build_beta_detail&.external_build_state) }
  if pending && state == "READY_FOR_BETA_SUBMISSION"
    UI.user_error!("TestFlight build #{pending.version} is already awaiting review in this train; retry staging after its review completes.")
  end
  unless ["READY_FOR_BETA_SUBMISSION", "BETA_APPROVED", *TESTFLIGHT_REVIEW_STATES, *TESTFLIGHT_AVAILABLE_STATES].include?(state)
    UI.user_error!("TestFlight build #{short_version} (#{build_number}) cannot be distributed in state #{state || "unknown"}; inspect App Store Connect before retrying staging.")
  end
  require "pilot"
  expected_notes = Pilot::BuildManager.sanitize_changelog(notes)
  UI.user_error!("Saved TestFlight What to Test notes are empty after Apple's formatting restrictions.") unless env_present?(expected_notes)
  existing_build_id = frozen.fetch("testflight")["existingBuildId"]
  if existing_build_id
    UI.user_error!("TestFlight staging target does not match the saved existing build.") unless build.id == existing_build_id
    # Adopting a store upload starts its first beta distribution. Only a retry
    # of these exact saved notes may reuse an already-noted build.
    different_notes = build.get_beta_build_localizations.any? do |localization|
      env_present?(localization.whats_new.to_s) &&
        (localization.locale != "en-US" || localization.whats_new != expected_notes)
    end
    UI.user_error!("The existing build already has different TestFlight notes; recover its original beta attempt before continuing.") if different_notes
  end
  # This is distribution-only. Upload and immutable source recording complete
  # first, so a rejected submission or partial metadata write can be recovered.
  upload_to_testflight(
    api_key: api_key,
    apple_id: app.id,
    app_platform: "ios",
    app_version: short_version,
    build_number: build_number,
    distribute_only: true,
    skip_waiting_for_build_processing: false,
    wait_processing_timeout_duration: APP_STORE_BUILD_PROCESSING_TIMEOUT_SECONDS,
    distribute_external: true,
    groups: [group.id],
    localized_build_info: { "en-US" => { whats_new: expected_notes } },
    notify_external_testers: true,
    submit_beta_review: state == "READY_FOR_BETA_SUBMISSION",
    skip_submission: false,
    reject_build_waiting_for_review: false,
    expire_previous_builds: false,
    uses_non_exempt_encryption: false
  )
  saved_build = Spaceship::ConnectAPI::Build.get(build_id: build.id, includes: "preReleaseVersion,buildBetaDetail")
  saved_notes = saved_build.get_beta_build_localizations.select { |localization| localization.locale == "en-US" }
  unless group.fetch_builds.any? { |candidate| candidate.id == build.id } && saved_build.build_beta_detail&.auto_notify_enabled == true &&
      saved_notes.length == 1 && saved_notes.first.whats_new == expected_notes
    UI.user_error!("TestFlight distribution readback did not match the group, automatic notification, and saved notes; retry staging without uploading again.")
  end
  state = saved_build.build_beta_detail.external_build_state
  outcome = if TESTFLIGHT_REVIEW_STATES.include?(state)
              "awaiting-review"
            elsif TESTFLIGHT_AVAILABLE_STATES.include?(state)
              "available"
            elsif state == "BETA_APPROVED"
              "approved"
            else
              UI.user_error!("TestFlight distribution returned state #{state}; reconcile this build before retrying staging. No new upload is needed.")
            end
  result = { "buildId" => build.id, "shortVersion" => short_version, "buildNumber" => build_number, "groupId" => group.id, "externalState" => state, "outcome" => outcome }
  result_path = ENV["OPENCLAW_TESTFLIGHT_RESULT_FILE"].to_s
  File.write(result_path, "#{JSON.pretty_generate(result)}\n") unless result_path.empty?
  UI.success("TestFlight build #{short_version} (#{build_number}): #{outcome}; external state #{state}.")
  result
end
