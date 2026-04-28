param(
    [string]$RequestPath,
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Request {
    param([string]$Path)
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 12)
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Data
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $Data | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function ConvertTo-RubySingleQuotedLiteral {
    param([string]$Value)

    if ($null -eq $Value) {
        return "''"
    }

    $escaped = $Value.Replace('\', '\\').Replace("'", "\\'")
    return "'$escaped'"
}

function New-ExtractorFailure {
    param(
        [string]$Code,
        [string]$Message,
        [hashtable]$Details = @{}
    )

    $exception = New-Object System.Exception($Message)
    $exception.Data['code'] = $Code
    foreach ($key in $Details.Keys) {
        $exception.Data[$key] = $Details[$key]
    }
    return $exception
}

function Resolve-SketchUpExecutable {
    param(
        [object]$Payload
    )

    if ($Payload -and $Payload.sketchupExePath) {
        $candidate = [string]$Payload.sketchupExePath
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }

        throw (New-ExtractorFailure -Code 'sketchup-executable-not-found' -Message "Configured SketchUp executable does not exist: $candidate" -Details @{
            extractor = 'extract-presentation-context-live'
            sketchupExePath = $candidate
        })
    }

    $roots = @(
        'C:\Program Files\SketchUp'
    )

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }

        $match = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'SketchUp\SketchUp.exe' } |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1

        if ($match) {
            return $match
        }
    }

    throw (New-ExtractorFailure -Code 'sketchup-executable-not-found' -Message 'SketchUp executable could not be found on the Windows host.' -Details @{
        extractor = 'extract-presentation-context-live'
    })
}

function Wait-ForArtifact {
    param(
        [string]$Path,
        [int]$TimeoutSeconds,
        [System.Diagnostics.Process]$Process
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            return
        }

        if ($Process.HasExited) {
            break
        }

        Start-Sleep -Milliseconds 500
        $Process.Refresh()
    }

    if (Test-Path -LiteralPath $Path) {
        return
    }

    $details = @{
        extractor = 'extract-presentation-context-live'
        timeoutSeconds = $TimeoutSeconds
    }

    if ($Process) {
        $details.processId = $Process.Id
        $details.processExited = $Process.HasExited
        if ($Process.HasExited) {
            $details.exitCode = $Process.ExitCode
        }
    }

    throw (New-ExtractorFailure -Code 'sketchup-live-artifact-timeout' -Message "Timed out waiting for SketchUp extraction artifact: $Path" -Details $details)
}

$request = Get-Request -Path $RequestPath
$payload = $request.payload
$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
if (-not $isWindowsHost) {
    throw (New-ExtractorFailure -Code 'host-platform-unsupported' -Message 'Live SketchUp extraction requires a Windows host.' -Details @{
        extractor = 'extract-presentation-context-live'
        platform = [System.Environment]::OSVersion.Platform.ToString()
    })
}

if (-not $payload -or -not $payload.modelPath) {
    throw (New-ExtractorFailure -Code 'sketchup-model-path-required' -Message 'Live SketchUp extraction currently requires payload.modelPath because attach-to-active-instance is not implemented yet.' -Details @{
        extractor = 'extract-presentation-context-live'
    })
}

$modelPath = [string]$payload.modelPath
if (-not (Test-Path -LiteralPath $modelPath)) {
    throw (New-ExtractorFailure -Code 'sketchup-model-not-found' -Message "SketchUp model file does not exist: $modelPath" -Details @{
        extractor = 'extract-presentation-context-live'
        modelPath = $modelPath
    })
}

$sketchupExePath = Resolve-SketchUpExecutable -Payload $payload
$timeoutSeconds = 120
if ($payload -and $payload.timeoutSeconds) {
    $timeoutSeconds = [int]$payload.timeoutSeconds
}

$keepSketchUpOpen = $false
if ($payload -and $null -ne $payload.keepSketchUpOpen) {
    $keepSketchUpOpen = [bool]$payload.keepSketchUpOpen
}

$tempRoot = Join-Path $env:TEMP ('ceviz-sketchup-live-' + [string]$request.requestId)
if (-not (Test-Path -LiteralPath $tempRoot)) {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
}

$rubyScriptPath = Join-Path $tempRoot 'extract_presentation_context.rb'
$rubyLogPath = Join-Path $tempRoot 'extract_presentation_context.log'
$artifactPath = [System.IO.Path]::GetFullPath($OutputPath)
$artifactDir = Split-Path -Parent $artifactPath
if ($artifactDir -and -not (Test-Path -LiteralPath $artifactDir)) {
    New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
}

$artifactPathRuby = ConvertTo-RubySingleQuotedLiteral -Value $artifactPath
$rubyLogPathRuby = ConvertTo-RubySingleQuotedLiteral -Value $rubyLogPath
$keepSketchUpOpenRuby = if ($keepSketchUpOpen) { 'true' } else { 'false' }

$rubyScript = @"
require 'json'

OUTPUT_PATH = $artifactPathRuby
LOG_PATH = $rubyLogPathRuby
KEEP_OPEN = $keepSketchUpOpenRuby

def log_line(message)
  File.open(LOG_PATH, 'a:utf-8') do |f|
    f.puts("[#{Time.now.utc.iso8601}] #{message}")
  end
end

def unit_label(code)
  {
    0 => 'inch',
    1 => 'foot',
    2 => 'millimeter',
    3 => 'centimeter',
    4 => 'meter',
    5 => 'yard'
  }[code] || "unknown(#{code})"
end

def normalize_name(name)
  name.to_s.downcase.gsub(/[^a-z0-9]+/, '')
end

def entity_name(entity)
  return nil unless entity.respond_to?(:name)
  value = entity.name.to_s.strip
  value.empty? ? nil : value
end

def layer_name(entity)
  return nil unless entity.respond_to?(:layer)
  layer = entity.layer
  return nil unless layer
  name = layer.name.to_s
  name.empty? ? nil : name
end

def material_name(entity)
  return nil unless entity.respond_to?(:material)
  material = entity.material
  return nil unless material
  name = material.display_name.to_s
  name.empty? ? nil : name
end

def scan_entities(entities, seen_definition_ids = [])
  stats = {
    component_instance_count: 0,
    group_count: 0,
    untagged_entity_count: 0,
    unnamed_entity_count: 0,
    default_material_entity_count: 0
  }

  entities.each do |entity|
    relevant = entity.is_a?(Sketchup::Group) || entity.is_a?(Sketchup::ComponentInstance)
    if relevant
      stats[:untagged_entity_count] += 1 if layer_name(entity).nil? || layer_name(entity) == 'Layer0'
      stats[:unnamed_entity_count] += 1 if entity_name(entity).nil?
      stats[:default_material_entity_count] += 1 if material_name(entity).nil?
    end

    if entity.is_a?(Sketchup::Group)
      stats[:group_count] += 1
      nested = scan_entities(entity.entities, seen_definition_ids)
      nested.each { |k, v| stats[k] += v }
    elsif entity.is_a?(Sketchup::ComponentInstance)
      stats[:component_instance_count] += 1
      definition = entity.definition
      definition_id = definition.respond_to?(:persistent_id) ? definition.persistent_id : definition.object_id
      next if seen_definition_ids.include?(definition_id)

      nested = scan_entities(definition.entities, seen_definition_ids + [definition_id])
      nested.each { |k, v| stats[k] += v }
    end
  end

  stats
end

def extract_payload
  model = Sketchup.active_model
  raise 'No active SketchUp model available.' unless model

  units_options = model.options['UnitsOptions']
  length_unit_code = units_options ? units_options['LengthUnit'] : nil
  tags = model.layers.map { |layer| layer.name.to_s }.reject { |name| name.empty? || name == 'Layer0' }.uniq
  pages = model.pages.map do |page|
    camera = page.camera
    {
      name: page.name.to_s,
      room: tags.find { |tag| page.name.to_s.downcase.include?(tag.downcase) },
      cameraType: camera && camera.respond_to?(:perspective?) && camera.perspective? ? 'perspective' : 'parallel'
    }
  end

  page_names = pages.map { |page| page[:name].to_s.downcase }
  room_coverage = tags.map do |tag|
    {
      room: tag,
      hasCamera: page_names.any? { |page_name| page_name.include?(tag.downcase) }
    }
  end

  materials = model.materials.map { |material| material.display_name.to_s }.reject(&:empty?)
  normalized = {}
  duplicates = []
  materials.each do |name|
    key = normalize_name(name)
    if !key.empty? && normalized[key] && normalized[key] != name
      duplicates << { a: normalized[key], b: name, reason: 'similar-name' }
    else
      normalized[key] = name
    end
  end

  selection_entity = model.selection.first
  stats = scan_entities(model.entities)
  active_page = model.pages.selected_page

  {
    scene: {
      name: model.title.to_s.empty? ? File.basename(model.path.to_s) : model.title.to_s,
      path: model.path.to_s,
      units: unit_label(length_unit_code),
      pageCount: model.pages.count,
      activePage: active_page ? active_page.name.to_s : nil,
      modelStats: {
        componentInstanceCount: stats[:component_instance_count],
        groupCount: stats[:group_count],
        tagCount: tags.count
      }
    },
    selection: {
      exists: !selection_entity.nil?,
      entityType: selection_entity ? selection_entity.typename.to_s.downcase.gsub(/\s+/, '_') : nil,
      name: selection_entity ? entity_name(selection_entity) : nil,
      tag: selection_entity ? layer_name(selection_entity) : nil,
      material: selection_entity ? material_name(selection_entity) : nil
    },
    organization: {
      tags: tags,
      untaggedEntityCount: stats[:untagged_entity_count],
      unnamedEntityCount: stats[:unnamed_entity_count],
      roomCoverage: room_coverage
    },
    materials: {
      materialCount: materials.count,
      defaultMaterialEntityCount: stats[:default_material_entity_count],
      placeholderMaterials: materials.select { |name| name.match?(/\A(color_\d+|material\d*|default)\z/i) },
      duplicates: duplicates
    },
    cameras: {
      pages: pages,
      missingRooms: room_coverage.reject { |item| item[:hasCamera] }.map { |item| item[:room] }
    },
    render: {
      source: 'sketchup-only',
      available: false,
      qualityPreset: nil,
      resolution: nil,
      warnings: [
        'vray-metadata-not-connected-yet',
        'Live extraction came from SketchUp Ruby startup path, not from a V-Ray integration.'
      ]
    },
    diagnostics: {
      partialRead: false,
      warnings: [
        'Live extraction executed by launching SketchUp with a RubyStartup script.',
        'Attach-to-active-instance is not implemented yet; payload.modelPath flow was used.'
      ],
      unsupportedFields: [
        'render.qualityPreset',
        'render.resolution'
      ],
      liveExtraction: {
        extractor: 'extract-presentation-context-live',
        transport: 'sketchup-ruby-startup',
        vrayConnected: false
      }
    }
  }
end

begin
  require 'time'
  UI.start_timer(1.0, false) do
    begin
      payload = extract_payload
      File.write(OUTPUT_PATH, JSON.pretty_generate(payload))
      log_line("wrote payload to #{OUTPUT_PATH}")
    rescue => e
      File.write(OUTPUT_PATH, JSON.pretty_generate({
        diagnostics: {
          rubyError: "#{e.class}: #{e.message}",
          rubyBacktrace: Array(e.backtrace).first(10)
        }
      }))
      log_line("ruby extraction failed: #{e.class}: #{e.message}")
    ensure
      Sketchup.quit unless KEEP_OPEN
    end
  end
rescue => e
  File.write(OUTPUT_PATH, JSON.pretty_generate({
    diagnostics: {
      rubyBootstrapError: "#{e.class}: #{e.message}",
      rubyBacktrace: Array(e.backtrace).first(10)
    }
  }))
  log_line("ruby bootstrap failed: #{e.class}: #{e.message}")
  Sketchup.quit unless KEEP_OPEN
end
"@

Set-Content -LiteralPath $rubyScriptPath -Value $rubyScript -Encoding UTF8

$arguments = @(
    '-RubyStartup', $rubyScriptPath,
    $modelPath
)

$process = Start-Process -FilePath $sketchupExePath -ArgumentList $arguments -PassThru
Wait-ForArtifact -Path $artifactPath -TimeoutSeconds $timeoutSeconds -Process $process

$payloadObject = Get-Content -LiteralPath $artifactPath -Raw | ConvertFrom-Json -Depth 12
if (-not $payloadObject.scene) {
    $rubyDiagnostics = $payloadObject.diagnostics | ConvertTo-Json -Depth 12 -Compress
    throw (New-ExtractorFailure -Code 'sketchup-ruby-extraction-failed' -Message "SketchUp Ruby extractor did not produce a valid scene payload. Diagnostics: $rubyDiagnostics" -Details @{
        extractor = 'extract-presentation-context-live'
        rubyLogPath = $rubyLogPath
    })
}

Write-JsonFile -Path $OutputPath -Data $payloadObject
return $payloadObject
