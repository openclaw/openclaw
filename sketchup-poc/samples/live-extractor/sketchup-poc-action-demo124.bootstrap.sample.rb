# frozen_string_literal: true

require 'json'
require 'fileutils'
require 'time'

module OpenClawSketchUpBootstrap
  CONTEXT_PATH = "C:\\OpenClaw\\SketchUpPoC\\bootstrap\\sketchup-poc-action-demo124.bootstrap-context.json"
  RUBY_SCRIPT_PATH = "C:\\OpenClaw\\SketchUpPoC\\bootstrap\\sketchup-poc-action-demo124.bootstrap.rb"

  def self.write_status(context, stage:, status:, message:)
    status_path = context.dig('output', 'bootstrapStatusPath')
    return unless status_path

    FileUtils.mkdir_p(File.dirname(status_path))

    active_model = Sketchup.active_model
    bounds = active_model&.bounds
    requested_path = context.dig('target', 'documentPath')
    model_path = active_model&.path
    requested_document_matches = if requested_path && !requested_path.empty? && model_path && !model_path.empty?
      File.expand_path(model_path).casecmp?(File.expand_path(requested_path))
    else
      nil
    end

    live_access_proof = {
      'proofKind' => 'sketchup-active-model-access',
      'activeModelAccessible' => !active_model.nil?,
      'rubyProcessId' => Process.pid,
      'rubyVersion' => RUBY_VERSION,
      'modelTitle' => active_model&.title,
      'modelPath' => model_path.nil? || model_path.empty? ? nil : model_path,
      'modelGuid' => active_model&.guid,
      'requestedDocumentPath' => requested_path,
      'requestedDocumentMatched' => requested_document_matches,
      'rootEntitiesAccessible' => !active_model.nil? && !active_model.entities.nil?,
      'rootEntityCount' => active_model&.entities&.length,
      'selectionAccessible' => !active_model.nil? && !active_model.selection.nil?,
      'selectionCount' => active_model&.selection&.length,
      'scenesAccessible' => !active_model.nil? && !active_model.pages.nil?,
      'sceneCount' => active_model&.pages&.length,
      'safeQueryProof' => {
        'queryKind' => 'model-bounds-summary',
        'sourceKind' => 'bootstrap-live-safe-query',
        'readOnly' => true,
        'available' => !active_model.nil? && !bounds.nil?,
        'status' => !active_model.nil? && !bounds.nil? ? 'available' : 'unavailable',
        'value' => if !active_model.nil? && !bounds.nil?
          {
            'width' => bounds.width,
            'height' => bounds.height,
            'depth' => bounds.depth,
            'diagonal' => bounds.diagonal
          }
        else
          nil
        end,
        'unavailableReason' => if active_model.nil?
          'active-model-unavailable'
        elsif bounds.nil?
          'model-bounds-unavailable'
        else
          nil
        end
      }
    }

    live_model_header = {
      'modelTitle' => active_model&.title,
      'modelPath' => model_path.nil? || model_path.empty? ? nil : model_path,
      'modelGuid' => active_model&.guid,
      'requestedDocumentMatched' => requested_document_matches,
      'sourceKind' => 'bootstrap-live-model-access',
      'stats' => {
        'entityCount' => active_model&.entities&.length,
        'sceneCount' => active_model&.pages&.length,
        'selectionCount' => active_model&.selection&.length
      }
    }

    artifact = {
      'kind' => 'sketchup-live-bootstrap-status',
      'contractVersion' => '1.0.0',
      'requestId' => context['requestId'],
      'action' => context['action'],
      'generatedAtUtc' => Time.now.utc.iso8601,
      'sourceKind' => 'bootstrap-live',
      'readOnly' => true,
      'bootstrap' => {
        'stage' => stage,
        'status' => status,
        'message' => message,
        'contextPath' => CONTEXT_PATH,
        'rubyScriptPath' => RUBY_SCRIPT_PATH,
        'snapshotOutputPath' => context.dig('output', 'snapshotOutputPath'),
        'responseArtifactPath' => context.dig('output', 'responseArtifactPath'),
        'documentPath' => context.dig('target', 'documentPath'),
        'documentName' => context.dig('target', 'documentName')
      },
      'liveModelHeader' => live_model_header,
      'liveModelAccess' => live_access_proof,
      'safeQueryProof' => live_access_proof['safeQueryProof'],
      'liveVsMock' => {
        'acknowledgedByRuby' => true,
        'sketchupLaunchExecuted' => true,
        'documentOpened' => requested_document_matches == true,
        'snapshotEmitted' => false,
        'traversalImplemented' => false
      },
      'warnings' => [
        'This bootstrap status artifact is emitted by the PoC Ruby stub.',
        'It proves Ruby-side access to Sketchup.active_model but does not prove live SketchUp traversal.',
        'Only lightweight model handle fields and collection counts are reported in this phase.'
      ]
    }

    File.write(status_path, JSON.pretty_generate(artifact) + "\n")
  end

  def self.run
    context = JSON.parse(File.read(CONTEXT_PATH))

    snapshot_path = context.dig('output', 'snapshotOutputPath')
    response_path = context.dig('output', 'responseArtifactPath')
    status_path = context.dig('output', 'bootstrapStatusPath')

    write_status(
      context,
      stage: 'startup',
      status: 'acknowledged',
      message: 'Ruby bootstrap stub loaded context, acknowledged the boundary, and read Sketchup.active_model.'
    )

    puts "[openclaw] bootstrap stub loaded for request=#{context['requestId']}"
    puts "[openclaw] intended document=#{context.dig('target', 'documentPath') || context.dig('target', 'documentName')}"
    puts "[openclaw] intended snapshot output=#{snapshot_path}"
    puts "[openclaw] intended response artifact=#{response_path}"
    puts "[openclaw] intended bootstrap status artifact=#{status_path}"
    puts "[openclaw] active_model title=#{Sketchup.active_model&.title.inspect} path=#{Sketchup.active_model&.path.inspect}"
    puts '[openclaw] live traversal is not implemented in this PoC phase.'
    keep_open = !!context.dig('runtime', 'keepSketchUpOpen')
    Sketchup.quit unless keep_open

    # Future implementation boundary:
    # 1. Load/open the target document safely in read-only-compatible flow.
    # 2. Traverse the active model and build a schema-shaped snapshot hash.
    # 3. Persist snapshot/output artifacts to the requested paths.
  rescue => e
    warn "[openclaw] bootstrap stub error: #{e.class}: #{e.message}"
    Sketchup.quit unless !!context.dig('runtime', 'keepSketchUpOpen')
    raise
  end
end

OpenClawSketchUpBootstrap.run
