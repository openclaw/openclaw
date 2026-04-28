# frozen_string_literal: true

require 'json'
require 'fileutils'
require 'time'

module OpenClawSketchUpBootstrap
  CONTEXT_PATH = "\\home\\mertb\\.openclaw\\workspace\\sketchup-poc\\tmp\\bootstrap\\local-smoke.bootstrap-context.json"
  RUBY_SCRIPT_PATH = "\\home\\mertb\\.openclaw\\workspace\\sketchup-poc\\tmp\\bootstrap\\local-smoke.bootstrap.rb"

  def self.safe_string(value)
    return nil if value.nil?

    text = value.to_s
    text.empty? ? nil : text
  rescue
    nil
  end

  def self.safe_float(value)
    return nil if value.nil?

    value.to_f
  rescue
    nil
  end

  def self.safe_point(point)
    return [0.0, 0.0, 0.0] if point.nil?

    [
      safe_float(point.x) || 0.0,
      safe_float(point.y) || 0.0,
      safe_float(point.z) || 0.0
    ]
  end

  def self.safe_entity_id(entity)
    if entity.respond_to?(:persistent_id)
      persistent_id = entity.persistent_id
      return "ent-#{persistent_id}" unless persistent_id.nil?
    end

    if entity.respond_to?(:entityID)
      entity_id = entity.entityID
      return "ent-#{entity_id}" unless entity_id.nil?
    end

    "ent-object-#{entity.object_id}"
  end

  def self.safe_name(entity)
    candidate = safe_string(entity.respond_to?(:name) ? entity.name : nil)
    return candidate if candidate

    if entity.respond_to?(:definition) && entity.definition
      definition_name = safe_string(entity.definition.name)
      return definition_name if definition_name
    end

    entity.class.name.split('::').last
  rescue
    'Entity'
  end

  def self.entity_kind(entity)
    case entity
    when Sketchup::ComponentInstance
      'component_instance'
    when Sketchup::Group
      'group'
    when Sketchup::Face
      'face'
    when Sketchup::Edge
      'edge'
    when Sketchup::ConstructionPoint
      'construction_point'
    when Sketchup::ConstructionLine
      'construction_line'
    when Sketchup::Text
      'text'
    when Sketchup::Dimension
      'dimension'
    when Sketchup::Image
      'image'
    else
      entity.class.name.split('::').last.gsub(/([a-z\d])([A-Z])/, '\1_\2').downcase
    end
  rescue
    'entity'
  end

  def self.safe_layer_name(entity)
    safe_string(entity.respond_to?(:layer) ? entity.layer&.name : nil)
  rescue
    nil
  end

  def self.safe_material_name(entity)
    material_name = safe_string(entity.respond_to?(:material) ? entity.material&.name : nil)
    return material_name if material_name

    if entity.respond_to?(:definition) && entity.definition
      safe_string(entity.definition.material&.name)
    end
  rescue
    nil
  end

  def self.safe_definition_name(entity)
    return nil unless entity.respond_to?(:definition) && entity.definition

    safe_string(entity.definition.name)
  rescue
    nil
  end

  def self.safe_transformation(entity)
    transformation = if entity.respond_to?(:transformation)
      entity.transformation
    else
      nil
    end

    return {
      'translation' => [0.0, 0.0, 0.0],
      'rotation' => [0.0, 0.0, 0.0],
      'scale' => [1.0, 1.0, 1.0]
    } if transformation.nil?

    {
      'translation' => safe_point(transformation.origin),
      'rotation' => [0.0, 0.0, 0.0],
      'scale' => [
        safe_float(transformation.xaxis&.length) || 1.0,
        safe_float(transformation.yaxis&.length) || 1.0,
        safe_float(transformation.zaxis&.length) || 1.0
      ]
    }
  rescue
    {
      'translation' => [0.0, 0.0, 0.0],
      'rotation' => [0.0, 0.0, 0.0],
      'scale' => [1.0, 1.0, 1.0]
    }
  end

  def self.safe_bounding_box(entity)
    bounds = entity.bounds
    {
      'min' => safe_point(bounds&.min),
      'max' => safe_point(bounds&.max)
    }
  rescue
    {
      'min' => [0.0, 0.0, 0.0],
      'max' => [0.0, 0.0, 0.0]
    }
  end

  def self.safe_attributes(entity)
    result = {}
    dictionaries = entity.respond_to?(:attribute_dictionaries) ? entity.attribute_dictionaries : nil
    return result if dictionaries.nil?

    dictionaries.each do |dictionary|
      dictionary.each_pair do |key, value|
        next unless value.nil? || value.is_a?(String) || value.is_a?(Numeric) || value == true || value == false

        result["#{dictionary.name}.#{key}"] = value
      end
    end
    result
  rescue
    {}
  end

  def self.serialize_entity(entity)
    {
      'id' => safe_entity_id(entity),
      'kind' => entity_kind(entity),
      'name' => safe_name(entity),
      'definitionName' => safe_definition_name(entity),
      'tag' => safe_layer_name(entity),
      'material' => safe_material_name(entity),
      'layerPath' => safe_layer_name(entity) ? [safe_layer_name(entity)] : [],
      'transform' => safe_transformation(entity),
      'boundingBox' => safe_bounding_box(entity),
      'attributes' => safe_attributes(entity)
    }
  end

  def self.model_unit_system(model)
    options = model.options['UnitsOptions']
    unit_code = options ? options['LengthUnit'] : nil
    case unit_code
    when 0 then 'inch'
    when 1 then 'foot'
    when 2 then 'millimeter'
    when 3 then 'centimeter'
    when 4 then 'meter'
    else 'unknown'
    end
  rescue
    'unknown'
  end

  def self.build_model_snapshot(context, active_model)
    entities = active_model.entities.map { |entity| serialize_entity(entity) }
    selection_ids = active_model.selection.map { |entity| safe_entity_id(entity) }
    tags = active_model.layers.map do |layer|
      {
        'id' => "tag-#{layer.persistent_id}",
        'name' => safe_string(layer.name) || 'Untagged',
        'visible' => !!layer.visible?
      }
    end
    materials = active_model.materials.map do |material|
      {
        'id' => "mat-#{material.persistent_id}",
        'name' => safe_string(material.name) || 'Unnamed Material'
      }
    end
    scenes = active_model.pages.map.with_index do |page, index|
      {
        'id' => "scene-#{page.persistent_id}",
        'name' => safe_string(page.name) || "Scene #{index + 1}",
        'index' => index
      }
    end

    top_tags = entities.each_with_object(Hash.new(0)) do |entity, acc|
      next unless entity['tag']
      acc[entity['tag']] += 1
    end.sort_by { |name, count| [-count, name] }.first(5).map { |name, count| { 'name' => name, 'count' => count } }

    top_definitions = entities.each_with_object(Hash.new(0)) do |entity, acc|
      next unless entity['definitionName']
      acc[entity['definitionName']] += 1
    end.sort_by { |name, count| [-count, name] }.first(5).map { |name, count| { 'name' => name, 'count' => count } }

    {
      'schemaVersion' => '1.0.0',
      'source' => {
        'app' => 'SketchUp',
        'appVersion' => safe_string(Sketchup.version.to_s) || 'unknown',
        'documentName' => safe_string(File.basename(active_model.path)) || safe_string(context.dig('target', 'documentName')) || 'Untitled.skp',
        'documentPath' => safe_string(active_model.path) || safe_string(context.dig('target', 'documentPath')) || 'unsaved://active-model',
        'capturedAt' => Time.now.utc.iso8601,
        'captureMode' => 'manual',
        'readOnly' => true
      },
      'model' => {
        'title' => safe_string(active_model.title) || safe_string(context.dig('target', 'documentName')) || 'Untitled',
        'unitSystem' => model_unit_system(active_model),
        'tagCount' => active_model.layers.length,
        'sceneCount' => active_model.pages.length,
        'materialCount' => active_model.materials.length,
        'componentDefinitionCount' => active_model.definitions.length,
        'componentInstanceCount' => entities.count { |entity| entity['kind'] == 'component_instance' },
        'groupCount' => entities.count { |entity| entity['kind'] == 'group' },
        'entityCount' => entities.length
      },
      'selection' => {
        'count' => selection_ids.length,
        'entityIds' => selection_ids
      },
      'scenes' => scenes,
      'tags' => tags,
      'materials' => materials,
      'entities' => entities,
      'summaryHints' => {
        'topTags' => top_tags,
        'topDefinitions' => top_definitions,
        'warnings' => [
          'This first live slice traverses the active model root entities only.',
          'Nested instance traversal and richer geometry export are not included yet.'
        ]
      }
    }
  end

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
        'snapshotEmitted' => stage == 'snapshot-written',
        'traversalImplemented' => stage == 'snapshot-written'
      },
      'warnings' => [
        'This bootstrap status artifact is emitted by the PoC Ruby stub.',
        'It proves Ruby-side access to Sketchup.active_model and can emit a first live root-entity snapshot.',
        'This phase still stops at root entities and does not traverse nested instance contents.'
      ]
    }

    File.write(status_path, JSON.pretty_generate(artifact) + "\n")
  end

  def self.write_snapshot(context)
    snapshot_path = context.dig('output', 'snapshotOutputPath')
    raise 'snapshotOutputPath missing from bootstrap context' if snapshot_path.nil? || snapshot_path.empty?

    FileUtils.mkdir_p(File.dirname(snapshot_path))
    active_model = Sketchup.active_model
    snapshot = build_model_snapshot(context, active_model)
    File.write(snapshot_path, JSON.pretty_generate(snapshot) + "\n")

    {
      'path' => snapshot_path,
      'entityCount' => snapshot.dig('model', 'entityCount'),
      'selectionCount' => snapshot.dig('selection', 'count')
    }
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

    snapshot_info = write_snapshot(context)

    write_status(
      context,
      stage: 'snapshot-written',
      status: 'completed',
      message: "Live root-entity snapshot written to #{snapshot_info['path']} (entities=#{snapshot_info['entityCount']}, selection=#{snapshot_info['selectionCount']})."
    )

    puts "[openclaw] bootstrap stub loaded for request=#{context['requestId']}"
    puts "[openclaw] intended document=#{context.dig('target', 'documentPath') || context.dig('target', 'documentName')}"
    puts "[openclaw] intended snapshot output=#{snapshot_path}"
    puts "[openclaw] intended response artifact=#{response_path}"
    puts "[openclaw] intended bootstrap status artifact=#{status_path}"
    puts "[openclaw] active_model title=#{Sketchup.active_model&.title.inspect} path=#{Sketchup.active_model&.path.inspect}"
    puts "[openclaw] snapshot emitted to=#{snapshot_info['path']}"
    puts '[openclaw] live traversal slice captured root entities only.'
    keep_open = !!context.dig('runtime', 'keepSketchUpOpen')
    Sketchup.quit unless keep_open

    # Future implementation boundary:
    # 1. Load/open the target document safely in read-only-compatible flow.
    # 2. Extend traversal into nested component/group hierarchies.
    # 3. Persist richer geometry/definition provenance into the requested paths.
  rescue => e
    warn "[openclaw] bootstrap stub error: #{e.class}: #{e.message}"
    Sketchup.quit unless !!context.dig('runtime', 'keepSketchUpOpen')
    raise
  end
end

OpenClawSketchUpBootstrap.run
