# Opt-in phase and incident evidence. Resource sampling belongs to ios-resource-timeline.mjs.
class ScreenshotDiagnostics
  attr_reader :events

  PROCESSES = %w[OpenClaw OpenClawUITests-Runner testmanagerd DTServiceHub Simulator com.apple.CoreSimulator.CoreSimulatorService].freeze
  STARTUP_MARKERS = {
    "commandHeader" => "Command line invocation:",
    "packageGraphStarted" => "Resolve Package Graph",
    "packageGraphResolved" => "Resolved source packages:",
    "resultBundleAnnounced" => "Writing result bundle at path:",
    "runnerStarted" => "[Default] Running tests...",
    "suiteStarted" => "Test Suite 'Selected tests' started at"
  }.freeze

  def initialize(&persist)
    @events = []
    @persist = persist
  end

  def measure(phase, device: nil, udid: nil, log_path: nil)
    started_at = Time.now
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    event = { "phase" => phase, "deviceName" => device, "startedAt" => started_at.utc.iso8601 }
    @events << event
    persist
    if log_path
      event["startupProgressSeconds"] = {}
      observer = Thread.new do
        saved = nil
        loop do
          observe_startup_progress(log_path, started, event.fetch("startupProgressSeconds"))
          observe_launch_progress(log_path, started, event)
          observed = [event.fetch("startupProgressSeconds").length, event.fetch("launchProgress", {}).length]
          persist if saved != observed
          saved = observed
          sleep(1)
        end
      end
    end
    result = yield
    event["outcome"] = "succeeded"
    result
  rescue StandardError
    event["outcome"] = "failed"
    event["crashes"] = crashes_since(started_at, udid)
    raise
  ensure
    observer&.kill&.join
    if event
      observe_startup_progress(log_path, started, event.fetch("startupProgressSeconds")) if log_path
      observe_launch_progress(log_path, started, event, sample: false) if log_path
      event["durationSeconds"] = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      event["startup"] = startup_facts(log_path) if log_path
      persist
    end
  end

  private

  def observe_launch_progress(path, started, event, sample: true)
    launch = event["launchProgress"] ||= {}
    parent = child = nil
    File.foreach("#{path}.launch") do |line|
      match = line.match(/\A(shell-entered|helper-entered|launch-requested|child-launched|child-reaped)\t(\d+)\t(\d+)\t(\d+)\n\z/)
      next unless match
      name, seconds, parent_pid, child_pid = match.captures
      launch[name] ||= { "shellSeconds" => seconds.to_i, "observedSeconds" => (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2) }
      parent, child = parent_pid.to_i, child_pid.to_i if name == "child-launched"
    end
    return unless sample && child && !launch.key?("child-reaped") && !@startup_sample_taken
    return unless event["deviceName"].to_s.start_with?("iPad ")
    return if event.fetch("startupProgressSeconds").key?("commandHeader")
    return if Process.clock_gettime(Process::CLOCK_MONOTONIC) - started - launch.fetch("child-launched").fetch("observedSeconds") < 15
    @startup_sample_taken = true
    event["startupSample"] = { "outcome" => "interrupted", "requestedSeconds" => (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2) }
    persist
    sample_startup_child(path, parent, child, event.fetch("startupSample"))
  rescue SystemCallError
    nil
  end

  def sample_startup_child(path, parent, child, result)
    began = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    identity_path = "#{path}.identity"
    sample_path = "#{path}.sample"
    progress_path = "#{path}.sample-progress"
    identity = bounded_startup_probe(["/bin/ps", "-p", child.to_s, "-o", "ppid=,comm="], identity_path, 2)
    result["identityProbe"] = identity
    return result["outcome"] = "identity-unavailable" unless identity == "ok"
    actual_parent, command = File.read(identity_path, 4096).strip.split(/\s+/, 2)
    return result["outcome"] = "identity-mismatch" unless actual_parent.to_i == parent && File.basename(command.to_s) == "xcodebuild"
    result["parentVerified"] = true
    result["toolKind"] = if command == "/usr/bin/xcodebuild"
      "shim"
    elsif command.match?(%r{\A/Applications/[^/]+\.app/Contents/Developer/usr/bin/xcodebuild\z})
      "native"
    else
      "unclassified-xcodebuild"
    end
    progress = result["progressSeconds"] = {}
    result["outcome"] = bounded_startup_probe(
      ["/usr/bin/sample", child.to_s, "1", "10", "-file", sample_path], File::NULL, 5, error_output: progress_path
    ) do |elapsed|
      observe_sample_progress(progress_path, progress, elapsed)
      # Collection stays one second. Only observed completion grants report time.
      progress.key?("collectionCompleted") ? [progress.fetch("collectionCompleted") + 10, 15].min : 5
    end
    if result["outcome"] == "timeout"
      result["timeoutPhase"] = progress.key?("collectionCompleted") ? "report-processing" : "attachment-or-collection"
    end
    result["frames"] = sanitized_startup_frames(sample_path) if result["outcome"] == "ok"
  rescue SystemCallError
    result["outcome"] = "unavailable"
  ensure
    result["observerPausedSeconds"] = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - began).round(2)
    FileUtils.rm_f([identity_path, sample_path, progress_path])
    persist
  end

  def observe_sample_progress(path, progress, elapsed)
    File.read(path, 16_384).to_s.each_line do |line|
      name = if line.match?(/\ASampling process \d+ for 1 second with 10 milliseconds of run time between samples\s*\z/)
        "collectionAnnounced"
      elsif line.strip == "Sampling completed, processing symbols..."
        "collectionCompleted"
      elsif line.match?(/\ASample analysis of process \d+ written to file /)
        "reportWritten"
      end
      progress[name] ||= elapsed.round(2) if name
    end
  rescue SystemCallError
    nil
  end

  # The probe owns only its own process group. Its deadline never kills Xcode.
  def bounded_startup_probe(arguments, output, seconds, error_output: File::NULL)
    reaped = nil
    child = Process.spawn(*arguments, out: output, err: error_output, pgroup: true)
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    loop do
      reaped, status = Process.waitpid2(child, Process::WNOHANG)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
      limit = block_given? ? yield(elapsed) : seconds
      return status.success? ? "ok" : "failed" if reaped
      return "timeout" if elapsed >= limit
      sleep(0.05)
    end
  ensure
    if child && !reaped
      begin
        Process.kill("KILL", -child)
        Process.detach(child)
      rescue Errno::ESRCH, Errno::ECHILD
        nil
      end
    end
  end

  def sanitized_startup_frames(path)
    frames = []
    active = false
    thread = 0
    File.foreach(path).take(2000).each do |line|
      line = line.scrub
      active = true if line == "Call graph:\n"
      break if line.start_with?("Total number in stack")
      next unless active
      if line.match?(/\A\s+\d+ Thread_\d+/)
        thread += 1
        next
      end
      match = line.match(/\A([ |+!:]*)(\d+) (.+?)  \(in ([A-Za-z0-9_.+\-]+)\)/)
      next unless match
      indentation, count, symbol, image = match.captures
      next unless symbol.length <= 240 && symbol.match?(/\A[+\-\[A-Za-z_$][A-Za-z0-9_$ .():<>\[\]+,\-&*#]*\z/)
      frames << { "thread" => thread, "depth" => indentation.length, "samples" => count.to_i, "symbol" => symbol, "image" => image }
      break if frames.length >= 80
    end
    frames
  end

  # Temporary diagnostic: observe the existing file without piping native output.
  # These are arrival times (up to one poll late); native buffering can delay them.
  def observe_startup_progress(path, started, progress)
    File.foreach(path) do |line|
      line = line.scrub
      STARTUP_MARKERS.each do |name, marker|
        next if progress.key?(name) || !line.include?(marker)
        progress[name] = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      end
    end
  rescue SystemCallError
    nil
  end

  def persist
    @persist.call
  rescue SystemCallError
    UI.important("Could not save the optional screenshot diagnostic sample.")
  end

  def startup_facts(path)
    facts = { "testCaseStarts" => 0, "instrumentsConnectionTimeout" => false, "runnerBootstrapFailure" => false, "stalledWait" => false }
    File.foreach(path) do |line|
      line = line.scrub
      facts["testCaseStarts"] += 1 if line.match?(/Test Case .* started\./)
      facts["instrumentsConnectionTimeout"] = true if line.include?("com.apple.instruments.deviceservice.lockdown") && line.include?("timed out")
      facts["runnerBootstrapFailure"] = true if line.include?("operation never finished bootstrapping")
      facts["stalledWait"] = true if line.include?("handleStalledWait:")
    end
    facts
  rescue SystemCallError
    { "unavailable" => true }
  end

  def crashes_since(started_at, udid)
    directories = [File.expand_path("~/Library/Logs/DiagnosticReports"), "/Library/Logs/DiagnosticReports"]
    if udid
      directories << File.expand_path("~/Library/Developer/CoreSimulator/Devices/#{udid}/data/Library/Logs/CrashReporter")
    end
    directories.flat_map { |directory| Dir[File.join(directory, "*.ips")] }
      .select { |path| File.mtime(path) >= started_at && File.size(path) <= 10 * 1024 * 1024 }
      .sort_by { |path| File.mtime(path) }.last(10).filter_map do |path|
        contents = File.read(path)
        report = begin
          JSON.parse(contents)
        rescue JSON::ParserError
          JSON.parse(contents.split("\n", 2).last)
        end
        name = report["procName"]
        next unless PROCESSES.include?(name)
        thread = Array(report["threads"]).find { |entry| entry["triggered"] }
        frames = Array(thread && thread["frames"]).first(12).filter_map do |frame|
          symbol = frame["symbol"].to_s
          next unless symbol.length <= 240 && symbol.match?(/\A[+\-\[A-Za-z_][A-Za-z0-9_ .():<>\[\]+\-]*\z/)
          { "symbol" => symbol }
        end
        {
          "process" => name,
          "exception" => report.fetch("exception", {}).slice("type", "signal").select { |_key, value| value.to_s.match?(/\A[A-Z_0-9]+\z/) },
          "termination" => report.fetch("termination", {}).slice("namespace", "code").select { |_key, value| value.is_a?(Numeric) || value.to_s.match?(/\A[A-Z_0-9]+\z/) },
          "triggeredThreadFrames" => frames
        }
      rescue JSON::ParserError, SystemCallError, TypeError
        nil
      end
  rescue StandardError
    []
  end
end
