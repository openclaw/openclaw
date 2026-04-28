param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Ensure-ParentDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    Ensure-ParentDirectory -Path $Path
    $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "File not found: $Path"
    }

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 100)
}

function Get-PropertyValue {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }
        return $null
    }

    $match = $Object.PSObject.Properties.Match($Name)
    if ($null -eq $match -or $match.Count -eq 0) {
        return $null
    }

    return $match[0].Value
}

function Test-HasProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($Object -is [System.Collections.IDictionary]) {
        return $Object.Contains($Name)
    }

    return ($Object.PSObject.Properties.Match($Name).Count -gt 0)
}

function Get-RequiredPropertyValue {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$Path = '$'
    )

    if (-not (Test-HasProperty -Object $Object -Name $Name)) {
        throw "$Path is missing required property '$Name'."
    }

    $value = Get-PropertyValue -Object $Object -Name $Name
    if ($null -eq $value) {
        throw "$Path.$Name cannot be null."
    }

    return $value
}

function Test-NonEmptyString {
    param(
        [AllowNull()]
        [object]$Value
    )

    return (-not [string]::IsNullOrWhiteSpace([string]$Value))
}

function New-PreflightCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Key,
        [Parameter(Mandatory = $true)]
        [string]$Category,
        [Parameter(Mandatory = $true)]
        [string]$Status,
        [Parameter(Mandatory = $true)]
        [string]$Code,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [AllowNull()]
        [object]$Details = $null
    )

    return [ordered]@{
        key = $Key
        category = $Category
        status = $Status
        ok = ($Status -ne 'fail')
        code = $Code
        message = $Message
        details = $Details
    }
}

function Get-PreflightSummary {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Checks
    )

    return [ordered]@{
        passed = @($Checks | Where-Object { $_.status -eq 'pass' }).Count
        warned = @($Checks | Where-Object { $_.status -eq 'warn' }).Count
        failed = @($Checks | Where-Object { $_.status -eq 'fail' }).Count
    }
}

function Get-ArtifactPathDiagnostics {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [AllowNull()]
        [object]$Path
    )

    $pathText = if (Test-NonEmptyString -Value $Path) { [string]$Path } else { $null }
    $parentDirectory = $null
    $isAbsolute = $false
    $parentExists = $false

    if ($null -ne $pathText) {
        $parentDirectory = Split-Path -Parent $pathText
        try {
            $isAbsolute = [System.IO.Path]::IsPathRooted($pathText)
        }
        catch {
            $isAbsolute = $false
        }

        if (-not [string]::IsNullOrWhiteSpace($parentDirectory)) {
            $parentExists = Test-Path -LiteralPath $parentDirectory
        }
    }

    return [ordered]@{
        name = $Name
        path = $pathText
        present = ($null -ne $pathText)
        isAbsolute = $isAbsolute
        parentDirectory = if ([string]::IsNullOrWhiteSpace($parentDirectory)) { $null } else { $parentDirectory }
        parentExists = $parentExists
    }
}

function Get-RequestResponsePath {
    param(
        [AllowNull()]
        [object]$Request
    )

    if ($null -eq $Request) {
        return $null
    }

    $artifacts = Get-PropertyValue -Object $Request -Name 'artifacts'
    if ($null -eq $artifacts) {
        return $null
    }

    $candidate = Get-PropertyValue -Object $artifacts -Name 'responseArtifactPath'
    if (-not (Test-NonEmptyString -Value $candidate)) {
        return $null
    }

    return [string]$candidate
}

function Get-SnapshotKindForAction {
    param(
        [AllowNull()]
        [object]$Action
    )

    switch ([string]$Action) {
        'extract-model-snapshot' { return 'model' }
        'extract-selection-snapshot' { return 'selection' }
        default { return $null }
    }
}

function Get-LiveModelStats {
    param(
        [AllowNull()]
        [object]$LiveModelAccess
    )

    if ($null -eq $LiveModelAccess) {
        return $null
    }

    $entityCount = if ([bool](Get-PropertyValue -Object $LiveModelAccess -Name 'rootEntitiesAccessible')) {
        $value = Get-PropertyValue -Object $LiveModelAccess -Name 'rootEntityCount'
        if ($null -ne $value) { [int]$value } else { $null }
    }
    else {
        $null
    }

    $sceneCount = if ([bool](Get-PropertyValue -Object $LiveModelAccess -Name 'scenesAccessible')) {
        $value = Get-PropertyValue -Object $LiveModelAccess -Name 'sceneCount'
        if ($null -ne $value) { [int]$value } else { $null }
    }
    else {
        $null
    }

    $selectionCount = if ([bool](Get-PropertyValue -Object $LiveModelAccess -Name 'selectionAccessible')) {
        $value = Get-PropertyValue -Object $LiveModelAccess -Name 'selectionCount'
        if ($null -ne $value) { [int]$value } else { $null }
    }
    else {
        $null
    }

    if ($null -eq $entityCount -and $null -eq $sceneCount -and $null -eq $selectionCount) {
        return $null
    }

    return [ordered]@{
        entityCount = $entityCount
        sceneCount = $sceneCount
        selectionCount = $selectionCount
    }
}

function Get-LiveModelHeader {
    param(
        [AllowNull()]
        [object]$LiveModelAccess,
        [AllowNull()]
        [object]$Stats = $null
    )

    if ($null -eq $LiveModelAccess) {
        return $null
    }

    $modelTitle = Get-PropertyValue -Object $LiveModelAccess -Name 'modelTitle'
    $modelPath = Get-PropertyValue -Object $LiveModelAccess -Name 'modelPath'
    $modelGuid = Get-PropertyValue -Object $LiveModelAccess -Name 'modelGuid'
    $requestedDocumentMatched = Get-PropertyValue -Object $LiveModelAccess -Name 'requestedDocumentMatched'

    if (-not (Test-NonEmptyString -Value $modelTitle) -and
        -not (Test-NonEmptyString -Value $modelPath) -and
        -not (Test-NonEmptyString -Value $modelGuid) -and
        $null -eq $requestedDocumentMatched) {
        return $null
    }

    return [ordered]@{
        modelTitle = if (Test-NonEmptyString -Value $modelTitle) { [string]$modelTitle } else { $null }
        modelPath = if (Test-NonEmptyString -Value $modelPath) { [string]$modelPath } else { $null }
        modelGuid = if (Test-NonEmptyString -Value $modelGuid) { [string]$modelGuid } else { $null }
        requestedDocumentMatched = if ($null -ne $requestedDocumentMatched) { [bool]$requestedDocumentMatched } else { $null }
        sourceKind = 'bootstrap-live-model-access'
        stats = $Stats
    }
}

function Get-SafeQueryProof {
    param(
        [AllowNull()]
        [object]$SafeQueryProof
    )

    if ($null -eq $SafeQueryProof) {
        return $null
    }

    $queryKind = Get-PropertyValue -Object $SafeQueryProof -Name 'queryKind'
    $sourceKind = Get-PropertyValue -Object $SafeQueryProof -Name 'sourceKind'
    $available = Get-PropertyValue -Object $SafeQueryProof -Name 'available'
    $status = Get-PropertyValue -Object $SafeQueryProof -Name 'status'
    $value = Get-PropertyValue -Object $SafeQueryProof -Name 'value'
    $unavailableReason = Get-PropertyValue -Object $SafeQueryProof -Name 'unavailableReason'

    if (-not (Test-NonEmptyString -Value $queryKind) -and
        -not (Test-NonEmptyString -Value $sourceKind) -and
        $null -eq $available -and
        -not (Test-NonEmptyString -Value $status) -and
        $null -eq $value -and
        -not (Test-NonEmptyString -Value $unavailableReason)) {
        return $null
    }

    $normalizedAvailable = if ($null -ne $available) { [bool]$available } else { $null }
    $normalizedStatus = if (Test-NonEmptyString -Value $status) {
        [string]$status
    }
    elseif ($normalizedAvailable -eq $true) {
        'available'
    }
    elseif ($normalizedAvailable -eq $false) {
        'unavailable'
    }
    else {
        $null
    }

    return [ordered]@{
        queryKind = if (Test-NonEmptyString -Value $queryKind) { [string]$queryKind } else { $null }
        sourceKind = if (Test-NonEmptyString -Value $sourceKind) { [string]$sourceKind } else { $null }
        readOnly = $true
        available = $normalizedAvailable
        status = $normalizedStatus
        value = $value
        unavailableReason = if (Test-NonEmptyString -Value $unavailableReason) { [string]$unavailableReason } else { $null }
    }
}

function New-OutputArtifactManifest {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Request,
        [Parameter(Mandatory = $true)]
        [object]$Preflight,
        [AllowNull()]
        [object]$BootstrapPlan,
        [AllowNull()]
        [object]$LiveModelAccess,
        [Parameter(Mandatory = $true)]
        [string]$ExecutionState
    )

    $requestId = [string](Get-PropertyValue -Object $Request -Name 'requestId')
    $action = [string](Get-PropertyValue -Object $Request -Name 'action')
    $artifacts = Get-PropertyValue -Object $Request -Name 'artifacts'
    $snapshotOutputPath = if ($null -ne $artifacts) { Get-PropertyValue -Object $artifacts -Name 'snapshotOutputPath' } else { $null }
    $snapshotKind = Get-SnapshotKindForAction -Action $action
    $snapshotWritten = ($ExecutionState -eq 'succeeded-live')
    $liveStats = Get-LiveModelStats -LiveModelAccess $LiveModelAccess
    $liveModelHeader = Get-LiveModelHeader -LiveModelAccess $LiveModelAccess -Stats $liveStats
    $safeQueryProof = if ($null -ne $LiveModelAccess) { Get-SafeQueryProof -SafeQueryProof (Get-PropertyValue -Object $LiveModelAccess -Name 'safeQueryProof') } else { $null }

    return [ordered]@{
        kind = 'sketchup-live-extraction-output'
        contractVersion = '1.0.0'
        requestId = $requestId
        action = $action
        executionState = $ExecutionState
        sourceKind = if ($snapshotWritten) { 'live' } elseif ($ExecutionState -eq 'succeeded-live-model-access') { 'bootstrap-live-model-access' } elseif ($ExecutionState -eq 'succeeded-bootstrap-ack') { 'bootstrap-live-ack' } else { 'preflight-only' }
        readOnly = $true
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        preflight = [ordered]@{
            status = [string](Get-PropertyValue -Object $Preflight -Name 'status')
            bootstrapActionable = [bool](Get-PropertyValue -Object $Preflight -Name 'bootstrapActionable')
            trueLiveExtractionReady = [bool](Get-PropertyValue -Object $Preflight -Name 'trueLiveExtractionReady')
            blockerCodes = @((Get-PropertyValue -Object $Preflight -Name 'blockerCodes'))
        }
        bootstrap = if ($null -ne $BootstrapPlan) {
            [ordered]@{
                strategyKey = [string](Get-PropertyValue -Object $BootstrapPlan -Name 'strategyKey')
                ready = [bool](Get-PropertyValue -Object $BootstrapPlan -Name 'ready')
                invocation = Get-PropertyValue -Object $BootstrapPlan -Name 'invocation'
                artifacts = Get-PropertyValue -Object $BootstrapPlan -Name 'artifacts'
            }
        }
        else {
            $null
        }
        bootstrapAck = $null
        liveModelHeader = $liveModelHeader
        liveModelAccess = $null
        safeQueryProof = $safeQueryProof
        snapshot = if ($snapshotWritten) {
            [ordered]@{
                path = if (Test-NonEmptyString -Value $snapshotOutputPath) { [string]$snapshotOutputPath } else { $null }
                kind = $snapshotKind
                schemaPath = 'contracts/model-snapshot.schema.json'
            }
        }
        else {
            $null
        }
        validation = [ordered]@{
            attempted = $false
            valid = $null
            validator = $null
        }
        statsAvailable = ($null -ne $liveStats)
        stats = $liveStats
        warnings = if ($snapshotWritten) {
            @(
                'This artifact records the first live extraction slice produced by the Ruby bootstrap path.',
                'The emitted snapshot currently covers active-model root entities only.',
                'Any stats in this artifact are lightweight top-level counts derived from the same root-level traversal surface.'
            )
        }
        else {
            @(
                'This artifact records extractor execution/preflight state only.',
                'No live SketchUp snapshot has been emitted yet.',
                'Any stats in this artifact are lightweight top-level counts derived from Sketchup.active_model access, not traversal output.'
            )
        }
    }
}

function Get-BootstrapArtifactPaths {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Artifacts,
        [Parameter(Mandatory = $true)]
        [string]$RequestId
    )

    $responseArtifactPath = [string](Get-PropertyValue -Object $Artifacts -Name 'responseArtifactPath')
    $responseDirectory = Split-Path -Parent $responseArtifactPath
    $bootstrapDirectory = Join-Path $responseDirectory 'bootstrap'

    return [ordered]@{
        directory = $bootstrapDirectory
        manifestPath = Join-Path $bootstrapDirectory ("{0}.bootstrap-plan.json" -f $RequestId)
        rubyScriptPath = Join-Path $bootstrapDirectory ("{0}.bootstrap.rb" -f $RequestId)
        contextPath = Join-Path $bootstrapDirectory ("{0}.bootstrap-context.json" -f $RequestId)
        bootstrapStatusPath = Join-Path $bootstrapDirectory ("{0}.bootstrap-status.json" -f $RequestId)
    }
}

function Get-BooleanOptionValue {
    param(
        [AllowNull()]
        [object]$Options,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [bool]$Default = $false
    )

    if ($null -eq $Options -or -not (Test-HasProperty -Object $Options -Name $Name)) {
        return $Default
    }

    $value = Get-PropertyValue -Object $Options -Name $Name
    if ($null -eq $value) {
        return $Default
    }

    return [bool]$value
}

function Get-IntegerOptionValue {
    param(
        [AllowNull()]
        [object]$Options,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [int]$Default
    )

    if ($null -eq $Options -or -not (Test-HasProperty -Object $Options -Name $Name)) {
        return $Default
    }

    $value = Get-PropertyValue -Object $Options -Name $Name
    if ($null -eq $value) {
        return $Default
    }

    try {
        return [int]$value
    }
    catch {
        return $Default
    }
}

function New-BootstrapContext {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Request,
        [Parameter(Mandatory = $true)]
        [object]$Preflight,
        [Parameter(Mandatory = $true)]
        [object]$BootstrapArtifacts
    )

    $target = Get-PropertyValue -Object $Request -Name 'target'
    $options = Get-PropertyValue -Object $Request -Name 'options'
    $artifacts = Get-PropertyValue -Object $Request -Name 'artifacts'
    $strategy = Get-PropertyValue -Object $Request -Name 'strategy'

    $documentPath = if ($null -ne $options -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $options -Name 'documentPath'))) {
        [string](Get-PropertyValue -Object $options -Name 'documentPath')
    }
    elseif ($null -ne $target -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $target -Name 'documentPathHint'))) {
        [string](Get-PropertyValue -Object $target -Name 'documentPathHint')
    }
    else {
        $null
    }

    $documentName = if ($null -ne $options -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $options -Name 'documentName'))) {
        [string](Get-PropertyValue -Object $options -Name 'documentName')
    }
    elseif ($null -ne $target -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $target -Name 'documentNameHint'))) {
        [string](Get-PropertyValue -Object $target -Name 'documentNameHint')
    }
    else {
        $null
    }

    return [ordered]@{
        kind = 'sketchup-ruby-bootstrap-context'
        contractVersion = '1.0.0'
        requestId = [string](Get-PropertyValue -Object $Request -Name 'requestId')
        action = [string](Get-PropertyValue -Object $Request -Name 'action')
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        readOnly = $true
        strategy = [ordered]@{
            key = [string](Get-PropertyValue -Object $strategy -Name 'key')
            attachMode = [string](Get-PropertyValue -Object $strategy -Name 'attachMode')
            startupMode = [string](Get-PropertyValue -Object $strategy -Name 'startupMode')
        }
        target = [ordered]@{
            sketchupExecutablePathHint = if ($null -ne $target) { Get-PropertyValue -Object $target -Name 'sketchupExecutablePathHint' } else { $null }
            sketchupVersionHint = if ($null -ne $target) { Get-PropertyValue -Object $target -Name 'sketchupVersionHint' } else { $null }
            sketchupProcessId = if ($null -ne $target) { Get-PropertyValue -Object $target -Name 'sketchupProcessId' } else { $null }
            documentDetected = if ($null -ne $target) { [bool](Get-PropertyValue -Object $target -Name 'documentDetected') } else { $false }
            documentName = $documentName
            documentPath = $documentPath
            documentSource = if ($null -ne $target) { Get-PropertyValue -Object $target -Name 'documentSource' } else { $null }
        }
        output = [ordered]@{
            snapshotOutputPath = if ($null -ne $artifacts) { Get-PropertyValue -Object $artifacts -Name 'snapshotOutputPath' } else { $null }
            responseArtifactPath = if ($null -ne $artifacts) { Get-PropertyValue -Object $artifacts -Name 'responseArtifactPath' } else { $null }
            outputArtifactPath = if ($null -ne $artifacts) { Get-PropertyValue -Object $artifacts -Name 'outputArtifactPath' } else { $null }
            bootstrapStatusPath = [string](Get-PropertyValue -Object $BootstrapArtifacts -Name 'bootstrapStatusPath')
        }
        preflight = [ordered]@{
            status = [string](Get-PropertyValue -Object $Preflight -Name 'status')
            bootstrapActionable = [bool](Get-PropertyValue -Object $Preflight -Name 'bootstrapActionable')
            blockerCodes = @((Get-PropertyValue -Object $Preflight -Name 'blockerCodes'))
        }
        runtime = [ordered]@{
            bootstrapAckTimeoutSeconds = Get-IntegerOptionValue -Options $options -Name 'bootstrapAckTimeoutSeconds' -Default 90
            keepSketchUpOpen = Get-BooleanOptionValue -Options $options -Name 'keepSketchUpOpen' -Default $false
        }
        limitations = @(
            'This context is generated by the mock live extractor stub.',
            'It prepares a Ruby bootstrap boundary for live acknowledgment runs.',
            'Bootstrap acknowledgment can be attempted without claiming full recursive entity traversal.',
            'This slice emits a live root-entity snapshot only; nested traversal remains unimplemented.'
        )
    }
}

function New-RubyBootstrapScriptContent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ContextPath,
        [Parameter(Mandatory = $true)]
        [string]$RubyScriptPath
    )

    $escapedContextPath = $ContextPath.Replace('\', '\\')
    $escapedRubyScriptPath = $RubyScriptPath.Replace('\', '\\')
@"
# frozen_string_literal: true

require 'json'
require 'fileutils'
require 'time'

module OpenClawSketchUpBootstrap
  CONTEXT_PATH = "$escapedContextPath"
  RUBY_SCRIPT_PATH = "$escapedRubyScriptPath"

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
"@
}

function New-BootstrapPlan {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Request,
        [Parameter(Mandatory = $true)]
        [object]$Preflight
    )

    if (-not [bool](Get-PropertyValue -Object $Preflight -Name 'bootstrapActionable')) {
        return $null
    }

    $artifacts = Get-RequiredPropertyValue -Object $Request -Name 'artifacts'
    $requestId = [string](Get-RequiredPropertyValue -Object $Request -Name 'requestId')
    $target = Get-PropertyValue -Object $Request -Name 'target'
    $strategy = Get-PropertyValue -Object $Request -Name 'strategy'
    $bootstrapArtifacts = Get-BootstrapArtifactPaths -Artifacts $artifacts -RequestId $requestId
    $bootstrapContext = New-BootstrapContext -Request $Request -Preflight $Preflight -BootstrapArtifacts $bootstrapArtifacts
    $rubyScriptContent = New-RubyBootstrapScriptContent -ContextPath ([string]$bootstrapArtifacts.contextPath) -RubyScriptPath ([string]$bootstrapArtifacts.rubyScriptPath)

    $sketchupExecutablePath = if ($null -ne $target -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $target -Name 'sketchupExecutablePathHint'))) {
        [string](Get-PropertyValue -Object $target -Name 'sketchupExecutablePathHint')
    }
    else {
        $null
    }

    $documentPath = [string](Get-PropertyValue -Object $bootstrapContext.target -Name 'documentPath')
    $startupMode = [string](Get-PropertyValue -Object $strategy -Name 'startupMode')
    $attachMode = [string](Get-PropertyValue -Object $strategy -Name 'attachMode')
    $selectedStrategyKey = [string](Get-PropertyValue -Object $strategy -Name 'key')

    $launchArguments = @()
    if ($startupMode -eq 'ruby-startup') {
        $launchArguments += '-RubyStartup'
        $launchArguments += [string]$bootstrapArtifacts.rubyScriptPath
    }
    if (Test-NonEmptyString -Value $documentPath) {
        $launchArguments += $documentPath
    }

    return [ordered]@{
        strategyKey = $selectedStrategyKey
        ready = $true
        notes = @(
            'This plan materializes the Ruby/bootstrap boundary but does not execute it.',
            'The generated Ruby script now performs a first live root-entity traversal and snapshot write.',
            'A future implementation should extend this slice into nested traversal and richer geometry export.'
        )
        invocation = [ordered]@{
            executablePath = $sketchupExecutablePath
            attachMode = $attachMode
            startupMode = $startupMode
            launchArguments = @($launchArguments)
            commandPreview = if (Test-NonEmptyString -Value $sketchupExecutablePath) {
                @($sketchupExecutablePath) + $launchArguments -join ' '
            }
            else {
                $null
            }
        }
        artifacts = [ordered]@{
            bootstrapDirectory = [string]$bootstrapArtifacts.directory
            manifestPath = [string]$bootstrapArtifacts.manifestPath
            rubyScriptPath = [string]$bootstrapArtifacts.rubyScriptPath
            contextPath = [string]$bootstrapArtifacts.contextPath
            bootstrapStatusPath = [string]$bootstrapArtifacts.bootstrapStatusPath
        }
        bootstrapContext = $bootstrapContext
        rubyScriptPreview = $rubyScriptContent
    }
}

function Write-BootstrapPlanArtifacts {
    param(
        [Parameter(Mandatory = $true)]
        [object]$BootstrapPlan
    )

    $artifacts = Get-PropertyValue -Object $BootstrapPlan -Name 'artifacts'
    $bootstrapContext = Get-PropertyValue -Object $BootstrapPlan -Name 'bootstrapContext'
    $rubyScriptPreview = [string](Get-PropertyValue -Object $BootstrapPlan -Name 'rubyScriptPreview')

    Ensure-ParentDirectory -Path ([string](Get-PropertyValue -Object $artifacts -Name 'manifestPath'))
    Set-Content -LiteralPath ([string](Get-PropertyValue -Object $artifacts -Name 'rubyScriptPath')) -Value $rubyScriptPreview -Encoding UTF8
    Write-JsonFile -Path ([string](Get-PropertyValue -Object $artifacts -Name 'contextPath')) -Value $bootstrapContext

    $manifest = [ordered]@{
        kind = 'sketchup-live-bootstrap-plan'
        contractVersion = '1.0.0'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        strategyKey = [string](Get-PropertyValue -Object $BootstrapPlan -Name 'strategyKey')
        ready = [bool](Get-PropertyValue -Object $BootstrapPlan -Name 'ready')
        invocation = Get-PropertyValue -Object $BootstrapPlan -Name 'invocation'
        artifacts = $artifacts
        notes = Get-PropertyValue -Object $BootstrapPlan -Name 'notes'
        liveVsMock = [ordered]@{
            bootstrapArtifactsMaterialized = $true
            rubyScriptImplemented = $true
            rubyBootstrapStatusImplemented = $true
            sketchupLaunchExecuted = $false
            snapshotEmitted = $false
        }
    }

    Write-JsonFile -Path ([string](Get-PropertyValue -Object $artifacts -Name 'manifestPath')) -Value $manifest
}

function Get-SnapshotValidationResult {
    param(
        [AllowNull()]
        [string]$SnapshotPath
    )

    if (-not (Test-NonEmptyString -Value $SnapshotPath) -or -not (Test-Path -LiteralPath $SnapshotPath)) {
        return [ordered]@{
            attempted = $false
            valid = $null
            validator = $null
            error = $null
        }
    }

    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
    $validatorScript = Join-Path $repoRoot 'scripts\validate_model_snapshot.py'
    if (-not (Test-Path -LiteralPath $validatorScript)) {
        return [ordered]@{
            attempted = $false
            valid = $null
            validator = $null
            error = 'validator-script-missing'
        }
    }

    foreach ($pythonCommand in @('python', 'python3')) {
        try {
            $null = & $pythonCommand --version 2>$null
            if ($LASTEXITCODE -ne 0) {
                continue
            }

            $output = & $pythonCommand $validatorScript --input $SnapshotPath 2>&1
            return [ordered]@{
                attempted = $true
                valid = ($LASTEXITCODE -eq 0)
                validator = "$pythonCommand scripts/validate_model_snapshot.py"
                error = if ($LASTEXITCODE -eq 0) { $null } else { ($output | Out-String).Trim() }
            }
        }
        catch {
        }
    }

    return [ordered]@{
        attempted = $false
        valid = $null
        validator = $null
        error = 'python-not-available'
    }
}

function Get-LiveExtractorPreflight {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Request
    )

    $checks = New-Object System.Collections.Generic.List[object]
    $unsupportedReasons = New-Object System.Collections.Generic.List[string]
    $blockerCodes = New-Object System.Collections.Generic.List[string]

    $kind = Get-PropertyValue -Object $Request -Name 'kind'
    $contractVersion = Get-PropertyValue -Object $Request -Name 'contractVersion'
    $action = Get-PropertyValue -Object $Request -Name 'action'
    $readOnly = Get-PropertyValue -Object $Request -Name 'readOnly'
    $sourceKind = Get-PropertyValue -Object $Request -Name 'sourceKind'
    $target = Get-PropertyValue -Object $Request -Name 'target'
    $artifacts = Get-PropertyValue -Object $Request -Name 'artifacts'
    $strategy = Get-PropertyValue -Object $Request -Name 'strategy'
    $options = Get-PropertyValue -Object $Request -Name 'options'

    $selectedStrategyKey = if ($null -ne $strategy) { Get-PropertyValue -Object $strategy -Name 'key' } else { $null }
    $attachMode = if ($null -ne $strategy) { Get-PropertyValue -Object $strategy -Name 'attachMode' } else { $null }
    $startupMode = if ($null -ne $strategy) { Get-PropertyValue -Object $strategy -Name 'startupMode' } else { $null }

    $requestIssues = New-Object System.Collections.Generic.List[string]
    if ($kind -ne 'sketchup-live-extractor-request') { $requestIssues.Add('kind') }
    if ($contractVersion -ne '1.0.0') { $requestIssues.Add('contractVersion') }
    if (-not (Test-NonEmptyString -Value (Get-PropertyValue -Object $Request -Name 'requestId'))) { $requestIssues.Add('requestId') }
    if (-not (Test-NonEmptyString -Value (Get-PropertyValue -Object $Request -Name 'requestedAtUtc'))) { $requestIssues.Add('requestedAtUtc') }
    if (-not ($readOnly -is [bool]) -or (-not [bool]$readOnly)) { $requestIssues.Add('readOnly') }
    if ($sourceKind -notin @('bridge-live-handoff', 'manual-sample')) { $requestIssues.Add('sourceKind') }
    if ($null -eq $target) { $requestIssues.Add('target') }
    if ($null -eq $artifacts) { $requestIssues.Add('artifacts') }
    if ($null -eq $strategy) { $requestIssues.Add('strategy') }

    if ($requestIssues.Count -eq 0) {
        $checks.Add((New-PreflightCheck -Key 'request-completeness' -Category 'request' -Status 'pass' -Code 'request-complete' -Message 'Request contains the required contract fields for bootstrap preflight.' -Details ([ordered]@{
            sourceKind = $sourceKind
            readOnly = $readOnly
        })))
    }
    else {
        $checks.Add((New-PreflightCheck -Key 'request-completeness' -Category 'request' -Status 'fail' -Code 'request-incomplete' -Message 'Request is missing required contract fields or contains unsupported core values.' -Details ([ordered]@{
            missingOrInvalid = @($requestIssues)
        })))
        $blockerCodes.Add('request-incomplete')
    }

    $supportedActions = @('extract-model-snapshot')
    if ($supportedActions -contains $action) {
        $checks.Add((New-PreflightCheck -Key 'action-support' -Category 'request' -Status 'pass' -Code 'action-supported' -Message 'Requested action is supported by the current bootstrap preflight layer.' -Details ([ordered]@{
            action = $action
        })))
    }
    else {
        $checks.Add((New-PreflightCheck -Key 'action-support' -Category 'request' -Status 'fail' -Code 'unsupported-action' -Message 'Requested action is not supported by the current live bootstrap path.' -Details ([ordered]@{
            action = $action
            supportedActions = $supportedActions
        })))
        $unsupportedReasons.Add("action:$action")
        $blockerCodes.Add('unsupported-action')
    }

    $supportedStrategies = @(
        @{
            key = 'ruby-startup-open-document'
            attachMode = 'launch-or-reuse'
            startupMode = 'ruby-startup'
        }
    )
    $matchingStrategy = $supportedStrategies | Where-Object {
        $_.key -eq $selectedStrategyKey -and
        $_.attachMode -eq $attachMode -and
        $_.startupMode -eq $startupMode
    }

    if ($null -ne $strategy -and @($matchingStrategy).Count -gt 0) {
        $checks.Add((New-PreflightCheck -Key 'strategy-support' -Category 'strategy' -Status 'pass' -Code 'strategy-supported' -Message 'Strategy is a supported bootstrap candidate for the next live extractor phase.' -Details ([ordered]@{
            key = $selectedStrategyKey
            attachMode = $attachMode
            startupMode = $startupMode
        })))
    }
    else {
        $checks.Add((New-PreflightCheck -Key 'strategy-support' -Category 'strategy' -Status 'fail' -Code 'unsupported-strategy' -Message 'Strategy is not supported by the current bootstrap preflight layer.' -Details ([ordered]@{
            key = $selectedStrategyKey
            attachMode = $attachMode
            startupMode = $startupMode
            supportedStrategies = $supportedStrategies
        })))
        $unsupportedReasons.Add("strategy:$selectedStrategyKey")
        $blockerCodes.Add('unsupported-strategy')
    }

    $responseArtifactCandidate = if ($null -ne $artifacts) { Get-PropertyValue -Object $artifacts -Name 'responseArtifactPath' } else { $null }
    $outputArtifactCandidate = if ($null -ne $artifacts) { Get-PropertyValue -Object $artifacts -Name 'outputArtifactPath' } else { $null }
    $snapshotArtifactCandidate = if ($null -ne $artifacts) { Get-PropertyValue -Object $artifacts -Name 'snapshotOutputPath' } else { $null }

    $artifactDiagnostics = @(
        (Get-ArtifactPathDiagnostics -Name 'responseArtifactPath' -Path $responseArtifactCandidate),
        (Get-ArtifactPathDiagnostics -Name 'outputArtifactPath' -Path $outputArtifactCandidate),
        (Get-ArtifactPathDiagnostics -Name 'snapshotOutputPath' -Path $snapshotArtifactCandidate)
    )

    $missingArtifactNames = @($artifactDiagnostics | Where-Object { -not $_.present } | ForEach-Object { $_.name })
    $relativeArtifactNames = @($artifactDiagnostics | Where-Object { $_.present -and -not $_.isAbsolute } | ForEach-Object { $_.name })
    $missingParentNames = @($artifactDiagnostics | Where-Object { $_.present -and $_.isAbsolute -and -not $_.parentExists } | ForEach-Object { $_.name })

    if ($missingArtifactNames.Count -gt 0 -or $relativeArtifactNames.Count -gt 0) {
        $checks.Add((New-PreflightCheck -Key 'artifact-path-readiness' -Category 'artifacts' -Status 'fail' -Code 'artifact-path-not-ready' -Message 'Artifact paths must be present and absolute before bootstrap execution can start.' -Details ([ordered]@{
            missingPaths = $missingArtifactNames
            nonAbsolutePaths = $relativeArtifactNames
            paths = $artifactDiagnostics
        })))
        $blockerCodes.Add('artifact-path-not-ready')
    }
    elseif ($missingParentNames.Count -gt 0) {
        $checks.Add((New-PreflightCheck -Key 'artifact-path-readiness' -Category 'artifacts' -Status 'warn' -Code 'artifact-parent-create-required' -Message 'Artifact paths are usable, but one or more parent directories do not exist yet and would need to be created.' -Details ([ordered]@{
            missingParentPaths = $missingParentNames
            paths = $artifactDiagnostics
        })))
    }
    else {
        $checks.Add((New-PreflightCheck -Key 'artifact-path-readiness' -Category 'artifacts' -Status 'pass' -Code 'artifact-paths-ready' -Message 'Artifact paths are present, absolute, and already rooted in existing parent directories.' -Details ([ordered]@{
            paths = $artifactDiagnostics
        })))
    }

    $runningOnWindows = $false
    if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) {
        $runningOnWindows = [bool]$IsWindows
    }

    $optionsDocumentPath = if ($null -ne $options) { Get-PropertyValue -Object $options -Name 'documentPath' } else { $null }
    $targetDocumentPath = if ($null -ne $target) { Get-PropertyValue -Object $target -Name 'documentPathHint' } else { $null }
    $targetDocumentDetected = if ($null -ne $target) { [bool](Get-PropertyValue -Object $target -Name 'documentDetected') } else { $false }
    $documentPathCandidate = if (Test-NonEmptyString -Value $optionsDocumentPath) { [string]$optionsDocumentPath } elseif (Test-NonEmptyString -Value $targetDocumentPath) { [string]$targetDocumentPath } else { $null }
    $sketchupExecutableHint = if ($null -ne $target -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $target -Name 'sketchupExecutablePathHint'))) {
        [string](Get-PropertyValue -Object $target -Name 'sketchupExecutablePathHint')
    }
    elseif ($null -ne $options -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $options -Name 'sketchupExePath'))) {
        [string](Get-PropertyValue -Object $options -Name 'sketchupExePath')
    }
    else {
        $null
    }

    $environmentIssues = New-Object System.Collections.Generic.List[string]
    if (-not $runningOnWindows) { $environmentIssues.Add('host-not-windows') }
    if (-not (Test-NonEmptyString -Value $sketchupExecutableHint)) { $environmentIssues.Add('sketchup-executable-missing') }
    if (-not $targetDocumentDetected) { $environmentIssues.Add('document-not-detected') }
    if (-not (Test-NonEmptyString -Value $documentPathCandidate)) { $environmentIssues.Add('document-path-missing') }

    if ($environmentIssues.Count -eq 0) {
        $checks.Add((New-PreflightCheck -Key 'environment-readiness' -Category 'environment' -Status 'pass' -Code 'environment-ready' -Message 'Host and probe-derived target hints are sufficient for a bootstrap attempt.' -Details ([ordered]@{
            runningOnWindows = $runningOnWindows
            sketchupExecutableHint = $sketchupExecutableHint
            documentDetected = $targetDocumentDetected
            documentPathCandidate = $documentPathCandidate
        })))
    }
    else {
        $checks.Add((New-PreflightCheck -Key 'environment-readiness' -Category 'environment' -Status 'fail' -Code 'environment-not-ready' -Message 'Host or target environment is not ready for a real bootstrap attempt.' -Details ([ordered]@{
            issues = @($environmentIssues)
            runningOnWindows = $runningOnWindows
            sketchupExecutableHint = $sketchupExecutableHint
            documentDetected = $targetDocumentDetected
            documentPathCandidate = $documentPathCandidate
        })))
        $blockerCodes.Add('environment-not-ready')
    }

    $nonImplementationBlockingChecks = @($checks | Where-Object {
        $_.status -eq 'fail' -and $_.code -ne 'bootstrap-path-blocked'
    })
    $bootstrapActionable = ($unsupportedReasons.Count -eq 0 -and $nonImplementationBlockingChecks.Count -eq 0)
    $bootstrapAckImplemented = $true
    $fullLiveExtractionImplemented = $false

    if ($bootstrapActionable -and $bootstrapAckImplemented) {
        $checks.Add((New-PreflightCheck -Key 'bootstrap-path' -Category 'bootstrap' -Status 'pass' -Code 'bootstrap-path-ready' -Message 'Bootstrap prerequisites and implementation are available.' -Details ([ordered]@{
            bootstrapAckImplemented = $bootstrapAckImplemented
            fullLiveExtractionImplemented = $fullLiveExtractionImplemented
        })))
    }
    elseif ($bootstrapActionable) {
        $checks.Add((New-PreflightCheck -Key 'bootstrap-path' -Category 'bootstrap' -Status 'fail' -Code 'bootstrap-path-blocked' -Message 'Bootstrap prerequisites are present, but the SketchUp-side Ruby bootstrap and traversal entrypoint is still not implemented.' -Details ([ordered]@{
            bootstrapAckImplemented = $bootstrapAckImplemented
            fullLiveExtractionImplemented = $fullLiveExtractionImplemented
            blocker = 'SketchUp-side Ruby bootstrap / traversal entrypoint is not implemented yet.'
        })))
        $blockerCodes.Add('bootstrap-path-blocked')
    }
    else {
        $checks.Add((New-PreflightCheck -Key 'bootstrap-path' -Category 'bootstrap' -Status 'fail' -Code 'bootstrap-path-blocked' -Message 'Bootstrap path remains blocked until the failing request, strategy, artifact, or environment checks are resolved.' -Details ([ordered]@{
            bootstrapAckImplemented = $bootstrapAckImplemented
            fullLiveExtractionImplemented = $fullLiveExtractionImplemented
            upstreamBlockers = @($blockerCodes)
        })))
        $blockerCodes.Add('bootstrap-path-blocked')
    }

    $status = if ($unsupportedReasons.Count -gt 0) { 'unsupported' } elseif ($bootstrapActionable -and $bootstrapAckImplemented) { 'ready' } else { 'blocked' }
    $summary = Get-PreflightSummary -Checks $checks
    $normalizedSelectedStrategyKey = if (Test-NonEmptyString -Value $selectedStrategyKey) { [string]$selectedStrategyKey } else { $null }

    $checksArray = $checks.ToArray()
    $blockerCodesArray = @($blockerCodes | Select-Object -Unique)
    $unsupportedReasonsArray = @($unsupportedReasons | Select-Object -Unique)
    $trueLiveExtractionReady = ($bootstrapActionable -and $fullLiveExtractionImplemented)

    return [pscustomobject]@{
        status = $status
        bootstrapActionable = $bootstrapActionable
        trueLiveExtractionReady = $trueLiveExtractionReady
        selectedStrategyKey = $normalizedSelectedStrategyKey
        summary = $summary
        checks = $checksArray
        blockerCodes = $blockerCodesArray
        unsupportedReasons = $unsupportedReasonsArray
    }
}

function Remove-StaleArtifactFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    $directory = Split-Path -Parent $Path
    $fileName = Split-Path -Leaf $Path
    $staleName = '{0}.stale-{1}' -f $fileName, ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
    $stalePath = Join-Path $directory $staleName
    Move-Item -LiteralPath $Path -Destination $stalePath -Force
    return $stalePath
}

function Test-BootstrapStatusArtifact {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedRequestId,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedAction
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return [ordered]@{
            valid = $false
            code = 'bootstrap-status-missing'
            message = 'Bootstrap status artifact does not exist yet.'
            artifact = $null
        }
    }

    try {
        $artifact = Read-JsonFile -Path $Path
    }
    catch {
        return [ordered]@{
            valid = $false
            code = 'bootstrap-status-invalid'
            message = "Bootstrap status artifact is not valid JSON: $($_.Exception.Message)"
            artifact = $null
        }
    }

    $kind = Get-PropertyValue -Object $artifact -Name 'kind'
    $requestId = Get-PropertyValue -Object $artifact -Name 'requestId'
    $action = Get-PropertyValue -Object $artifact -Name 'action'
    $bootstrap = Get-PropertyValue -Object $artifact -Name 'bootstrap'
    $status = if ($null -ne $bootstrap) { Get-PropertyValue -Object $bootstrap -Name 'status' } else { $null }
    $stage = if ($null -ne $bootstrap) { Get-PropertyValue -Object $bootstrap -Name 'stage' } else { $null }

    $issues = New-Object System.Collections.Generic.List[string]
    if ($kind -ne 'sketchup-live-bootstrap-status') { $issues.Add('kind') | Out-Null }
    if ([string]$requestId -ne $ExpectedRequestId) { $issues.Add('requestId') | Out-Null }
    if ([string]$action -ne $ExpectedAction) { $issues.Add('action') | Out-Null }
    if ($null -eq $bootstrap) { $issues.Add('bootstrap') | Out-Null }
    if (-not (Test-NonEmptyString -Value $status)) { $issues.Add('bootstrap.status') | Out-Null }
    if (-not (Test-NonEmptyString -Value $stage)) { $issues.Add('bootstrap.stage') | Out-Null }

    if ($issues.Count -gt 0) {
        return [ordered]@{
            valid = $false
            code = 'bootstrap-status-invalid'
            message = 'Bootstrap status artifact is present but does not match the expected contract/request identity.'
            artifact = $artifact
            issues = @($issues)
        }
    }

    return [ordered]@{
        valid = $true
        code = 'bootstrap-status-valid'
        message = 'Bootstrap status artifact matches the expected request.'
        artifact = $artifact
        issues = @()
    }
}

function Wait-ForBootstrapStatusArtifact {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedRequestId,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedAction,
        [AllowNull()]
        [System.Diagnostics.Process]$Process = $null
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastValidation = $null

    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            $lastValidation = Test-BootstrapStatusArtifact -Path $Path -ExpectedRequestId $ExpectedRequestId -ExpectedAction $ExpectedAction
            if ($lastValidation.valid) {
                return [ordered]@{
                    status = 'acknowledged'
                    artifact = $lastValidation.artifact
                    validation = $lastValidation
                }
            }
        }

        if ($null -ne $Process) {
            try {
                $Process.Refresh()
                if ($Process.HasExited) {
                    break
                }
            }
            catch {
            }
        }

        Start-Sleep -Milliseconds 500
    }

    $details = [ordered]@{
        path = $Path
        timeoutSeconds = $TimeoutSeconds
        requestId = $ExpectedRequestId
        action = $ExpectedAction
    }
    if ($null -ne $lastValidation) {
        $details.lastValidation = $lastValidation
    }
    if ($null -ne $Process) {
        try {
            $Process.Refresh()
            $details.processId = $Process.Id
            $details.processExited = $Process.HasExited
            if ($Process.HasExited) {
                $details.exitCode = $Process.ExitCode
            }
        }
        catch {
        }
    }

    throw ([System.TimeoutException]::new(("Timed out waiting for bootstrap status artifact: {0}" -f $Path)))
}

function Invoke-BootstrapAck {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Request,
        [Parameter(Mandatory = $true)]
        [object]$BootstrapPlan
    )

    $requestId = [string](Get-RequiredPropertyValue -Object $Request -Name 'requestId')
    $action = [string](Get-RequiredPropertyValue -Object $Request -Name 'action')
    $options = Get-PropertyValue -Object $Request -Name 'options'
    $target = Get-PropertyValue -Object $Request -Name 'target'
    $invocation = Get-PropertyValue -Object $BootstrapPlan -Name 'invocation'
    $bootstrapArtifacts = Get-PropertyValue -Object $BootstrapPlan -Name 'artifacts'
    $bootstrapStatusPath = [string](Get-PropertyValue -Object $bootstrapArtifacts -Name 'bootstrapStatusPath')
    $rubyScriptPath = [string](Get-PropertyValue -Object $bootstrapArtifacts -Name 'rubyScriptPath')
    $documentPath = if ($null -ne $options -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $options -Name 'documentPath'))) {
        [string](Get-PropertyValue -Object $options -Name 'documentPath')
    } elseif ($null -ne $target -and (Test-NonEmptyString -Value (Get-PropertyValue -Object $target -Name 'documentPathHint'))) {
        [string](Get-PropertyValue -Object $target -Name 'documentPathHint')
    } else {
        $null
    }

    $timeoutSeconds = Get-IntegerOptionValue -Options $options -Name 'bootstrapAckTimeoutSeconds' -Default 90
    if ($timeoutSeconds -lt 5) {
        $timeoutSeconds = 5
    }

    $launchArguments = @((Get-PropertyValue -Object $invocation -Name 'launchArguments'))
    $executablePath = [string](Get-PropertyValue -Object $invocation -Name 'executablePath')
    if (-not (Test-NonEmptyString -Value $executablePath)) {
        throw 'Bootstrap invocation is missing a SketchUp executable path.'
    }

    $staleBootstrapStatusPath = Remove-StaleArtifactFile -Path $bootstrapStatusPath
    $process = $null
    $launchMode = 'launch-new-process'
    $launchedAt = Get-Date

    try {
        $process = Start-Process -FilePath $executablePath -ArgumentList $launchArguments -PassThru
    }
    catch {
        $details = [ordered]@{
            executablePath = $executablePath
            launchArguments = $launchArguments
            rubyScriptPath = $rubyScriptPath
            documentPath = $documentPath
        }
        throw (New-Object System.Management.Automation.RuntimeException(("Failed to launch SketchUp for bootstrap ack: {0}" -f $_.Exception.Message)))
    }

    try {
        $waitResult = Wait-ForBootstrapStatusArtifact -Path $bootstrapStatusPath -TimeoutSeconds $timeoutSeconds -ExpectedRequestId $requestId -ExpectedAction $action -Process $process
        $ackArtifact = $waitResult.artifact
        $bootstrap = Get-PropertyValue -Object $ackArtifact -Name 'bootstrap'

        $snapshotOutputPath = if ($null -ne $options -and (Test-NonEmptyString -Value (Get-PropertyValue -Object (Get-PropertyValue -Object $Request -Name 'artifacts') -Name 'snapshotOutputPath'))) {
            [string](Get-PropertyValue -Object (Get-PropertyValue -Object $Request -Name 'artifacts') -Name 'snapshotOutputPath')
        }
        else {
            $null
        }
        $snapshotWritten = (Test-NonEmptyString -Value $snapshotOutputPath) -and (Test-Path -LiteralPath $snapshotOutputPath)
        $liveModelAccessible = ($null -ne $ackArtifact -and (Get-PropertyValue -Object $ackArtifact -Name 'liveModelAccess') -and [bool](Get-PropertyValue -Object (Get-PropertyValue -Object $ackArtifact -Name 'liveModelAccess') -Name 'activeModelAccessible'))

        return [ordered]@{
            ok = $true
            executionState = if ($snapshotWritten) { 'succeeded-live' } elseif ($liveModelAccessible) { 'succeeded-live-model-access' } else { 'succeeded-bootstrap-ack' }
            processId = if ($null -ne $process) { [int]$process.Id } else { $null }
            launchMode = $launchMode
            launchedAtUtc = $launchedAt.ToUniversalTime().ToString('o')
            startupMs = [int](((Get-Date) - $launchedAt).TotalMilliseconds)
            bootstrapStatusPath = $bootstrapStatusPath
            snapshotPath = $snapshotOutputPath
            snapshotWritten = $snapshotWritten
            bootstrapStatus = $ackArtifact
            liveModelHeader = Get-PropertyValue -Object $ackArtifact -Name 'liveModelHeader'
            liveModelAccess = Get-PropertyValue -Object $ackArtifact -Name 'liveModelAccess'
            safeQueryProof = Get-SafeQueryProof -SafeQueryProof (Get-PropertyValue -Object $ackArtifact -Name 'safeQueryProof')
            bootstrap = [ordered]@{
                stage = if ($null -ne $bootstrap) { [string](Get-PropertyValue -Object $bootstrap -Name 'stage') } else { $null }
                status = if ($null -ne $bootstrap) { [string](Get-PropertyValue -Object $bootstrap -Name 'status') } else { $null }
                message = if ($null -ne $bootstrap) { Get-PropertyValue -Object $bootstrap -Name 'message' } else { $null }
            }
            staleBootstrapStatusPath = $staleBootstrapStatusPath
        }
    }
    catch {
        $details = [ordered]@{
            bootstrapStatusPath = $bootstrapStatusPath
            timeoutSeconds = $timeoutSeconds
            processId = if ($null -ne $process) { [int]$process.Id } else { $null }
            launchMode = $launchMode
            staleBootstrapStatusPath = $staleBootstrapStatusPath
            executablePath = $executablePath
            launchArguments = $launchArguments
            rubyScriptPath = $rubyScriptPath
            documentPath = $documentPath
        }
        if ($_.Exception -is [System.TimeoutException]) {
            throw (New-Object System.Management.Automation.RuntimeException(("Timed out waiting for SketchUp bootstrap acknowledgment: {0}" -f $_.Exception.Message)))
        }
        throw
    }
}

$startedAt = Get-Date
$responsePath = $null
$request = $null

try {
    $request = Read-JsonFile -Path $RequestPath
    $responsePath = Get-RequestResponsePath -Request $request

    if ([string]::IsNullOrWhiteSpace($responsePath)) {
        throw 'The request is missing artifacts.responseArtifactPath, so the response artifact cannot be materialized.'
    }

    $requestId = [string](Get-RequiredPropertyValue -Object $request -Name 'requestId')
    $action = [string](Get-RequiredPropertyValue -Object $request -Name 'action')
    $artifacts = Get-RequiredPropertyValue -Object $request -Name 'artifacts'
    $outputArtifactPath = Get-PropertyValue -Object $artifacts -Name 'outputArtifactPath'
    $snapshotOutputPath = Get-PropertyValue -Object $artifacts -Name 'snapshotOutputPath'
    $preflight = Get-LiveExtractorPreflight -Request $request
    $outputArtifactPath = if (Test-NonEmptyString -Value $outputArtifactPath) { [string]$outputArtifactPath } else { $null }

    $errorList = New-Object System.Collections.Generic.List[object]
    foreach ($check in @($preflight.checks | Where-Object { $_.status -eq 'fail' })) {
        $retryable = ($check.code -in @('artifact-path-not-ready', 'environment-not-ready'))
        $errorCode = switch ($check.code) {
            'request-incomplete' { 'request-incomplete' }
            'unsupported-action' { 'unsupported-action' }
            'unsupported-strategy' { 'unsupported-strategy' }
            'artifact-path-not-ready' { 'artifact-path-not-ready' }
            'environment-not-ready' { 'environment-not-ready' }
            'bootstrap-path-blocked' {
                if ($preflight.bootstrapActionable) { 'live-extraction-not-implemented' } else { 'bootstrap-path-blocked' }
            }
            default { 'unexpected-extractor-error' }
        }

        $errorList.Add([ordered]@{
            code = $errorCode
            message = $check.message
            stage = 'preflight'
            retryable = $retryable
            details = $check.details
        })
    }

    $bootstrapPlan = New-BootstrapPlan -Request $request -Preflight $preflight
    if ($null -ne $bootstrapPlan) {
        Write-BootstrapPlanArtifacts -BootstrapPlan $bootstrapPlan
    }

    $bootstrapAck = $null
    $executionState = if ($preflight.bootstrapActionable) { 'failed-not-implemented' } else { 'failed-preflight' }

    if ($preflight.status -eq 'ready' -and $null -ne $bootstrapPlan) {
        try {
            $bootstrapAck = Invoke-BootstrapAck -Request $request -BootstrapPlan $bootstrapPlan
            $executionState = [string](Get-PropertyValue -Object $bootstrapAck -Name 'executionState')
        }
        catch {
            $errorList.Add([ordered]@{
                code = if ($_.Exception.Message -like 'Timed out waiting for SketchUp bootstrap acknowledgment*') { 'ruby-bootstrap-timeout' } else { 'sketchup-launch-failed' }
                message = $_.Exception.Message
                stage = if ($_.Exception.Message -like 'Timed out waiting for SketchUp bootstrap acknowledgment*') { 'ruby-bootstrap' } else { 'startup' }
                retryable = $true
                details = $null
            })
            $executionState = 'failed-live'
        }
    }

    $liveModelAccess = if ($null -ne $bootstrapAck) { Get-PropertyValue -Object $bootstrapAck -Name 'liveModelAccess' } else { $null }
    $liveModelHeader = if ($null -ne $bootstrapAck) { Get-PropertyValue -Object $bootstrapAck -Name 'liveModelHeader' } else { $null }
    $safeQueryProof = if ($null -ne $bootstrapAck) { Get-SafeQueryProof -SafeQueryProof (Get-PropertyValue -Object $bootstrapAck -Name 'safeQueryProof') } else { $null }
    $liveStats = Get-LiveModelStats -LiveModelAccess $liveModelAccess
    $snapshotArtifactPath = if ($null -ne $bootstrapAck) { [string](Get-PropertyValue -Object $bootstrapAck -Name 'snapshotPath') } elseif (Test-NonEmptyString -Value $snapshotOutputPath) { [string]$snapshotOutputPath } else { $null }
    $snapshotWritten = ($executionState -eq 'succeeded-live') -and (Test-NonEmptyString -Value $snapshotArtifactPath) -and (Test-Path -LiteralPath $snapshotArtifactPath)
    $snapshotValidation = Get-SnapshotValidationResult -SnapshotPath $snapshotArtifactPath
    if ($snapshotWritten -and $snapshotValidation.attempted -and $snapshotValidation.valid -eq $false) {
        $errorList.Add([ordered]@{
            code = 'snapshot-schema-invalid'
            message = 'Live snapshot was written but failed schema validation.'
            stage = 'validation'
            retryable = $false
            details = [ordered]@{
                snapshotPath = $snapshotArtifactPath
                validator = $snapshotValidation.validator
                error = $snapshotValidation.error
            }
        })
        $executionState = 'failed-live'
        $snapshotWritten = $false
    }
    $outputArtifact = if ($null -ne $outputArtifactPath) {
        New-OutputArtifactManifest -Request $request -Preflight $preflight -BootstrapPlan $bootstrapPlan -LiveModelAccess $liveModelAccess -ExecutionState $executionState
    }
    else {
        $null
    }

    $warnings = New-Object System.Collections.Generic.List[string]
    if ($executionState -eq 'succeeded-live') {
        $warnings.Add('A first live root-entity snapshot was emitted from SketchUp Ruby.')
    }
    else {
        $warnings.Add('The live extractor still does not emit a validated recursive live snapshot in this phase.')
    }
    if (@($preflight.checks | Where-Object { $_.status -eq 'warn' }).Count -gt 0) {
        $warnings.Add('At least one preflight check produced warnings; inspect response.preflight.checks for the exact path readiness details.')
    }
    if ($null -ne $bootstrapAck) {
        if ($executionState -eq 'succeeded-live') {
            $warnings.Add('The emitted live snapshot is intentionally thin and currently limited to active-model root entities.')
        }
        elseif ($executionState -eq 'succeeded-live-model-access') {
            $warnings.Add('A real SketchUp-side bootstrap artifact proved Ruby-side access to Sketchup.active_model, but snapshot emission did not complete.')
        }
        else {
            $warnings.Add('A real SketchUp-side bootstrap acknowledgment artifact was observed, but traversal and snapshot emission are still unimplemented.')
        }
    }
    else {
        $warnings.Add('No live snapshot was written because this phase stopped before snapshot completion.')
    }
    if ($null -ne $outputArtifact) {
        $warnings.Add('An execution manifest artifact is being written so downstream tooling can inspect state without pretending a snapshot exists.')
    }
    if ($null -ne $bootstrapPlan) {
        if ($null -ne $bootstrapAck) {
            $warnings.Add('Bootstrap artifacts were materialized and the Ruby startup path acknowledged them from inside SketchUp.')
        }
        else {
            $warnings.Add('Bootstrap artifacts were materialized for the SketchUp-side path, but no acknowledgment was observed.')
        }
    }

    $responseSourceKind = if ($executionState -eq 'succeeded-bootstrap-ack' -or $executionState -eq 'succeeded-live-model-access' -or $executionState -eq 'failed-live') { 'live-extractor' } else { 'mock-extractor-stub' }
    $startupMs = if ($null -ne $bootstrapAck) { [int](Get-PropertyValue -Object $bootstrapAck -Name 'startupMs') } else { $null }
    $normalizedOutputArtifactPath = if (Test-NonEmptyString -Value $outputArtifactPath) { [string]$outputArtifactPath } else { $null }
    $normalizedSnapshotOutputPath = if (Test-NonEmptyString -Value $snapshotOutputPath) { [string]$snapshotOutputPath } else { $null }

    $responseDurations = @{
        totalMs = [int](((Get-Date) - $startedAt).TotalMilliseconds)
        startupMs = $startupMs
        documentOpenMs = $null
        snapshotWriteMs = $null
    }
    $responseArtifacts = @{
        responseArtifactPath = $responsePath
        outputArtifactPath = $normalizedOutputArtifactPath
        snapshotOutputPath = $normalizedSnapshotOutputPath
    }
    $warningsArray = $warnings.ToArray()
    $errorsArray = $errorList.ToArray()
    $response = New-Object psobject
    $response | Add-Member -NotePropertyName 'kind' -NotePropertyValue 'sketchup-live-extractor-response'
    $response | Add-Member -NotePropertyName 'contractVersion' -NotePropertyValue '1.0.0'
    $response | Add-Member -NotePropertyName 'requestId' -NotePropertyValue $requestId
    $response | Add-Member -NotePropertyName 'action' -NotePropertyValue $action
    $response | Add-Member -NotePropertyName 'ok' -NotePropertyValue ($executionState -eq 'succeeded-bootstrap-ack' -or $executionState -eq 'succeeded-live-model-access')
    $response | Add-Member -NotePropertyName 'executionState' -NotePropertyValue $executionState
    $response | Add-Member -NotePropertyName 'sourceKind' -NotePropertyValue $responseSourceKind
    $response | Add-Member -NotePropertyName 'readOnly' -NotePropertyValue $true
    $response | Add-Member -NotePropertyName 'generatedAtUtc' -NotePropertyValue ([DateTime]::UtcNow.ToString('o'))
    $response | Add-Member -NotePropertyName 'durations' -NotePropertyValue $responseDurations
    $response | Add-Member -NotePropertyName 'artifacts' -NotePropertyValue $responseArtifacts
    $response | Add-Member -NotePropertyName 'preflight' -NotePropertyValue $preflight
    $response | Add-Member -NotePropertyName 'result' -NotePropertyValue $null
    $response | Add-Member -NotePropertyName 'warnings' -NotePropertyValue $warningsArray
    $response | Add-Member -NotePropertyName 'errors' -NotePropertyValue $errorsArray

    if ($null -ne $outputArtifact) {
        Write-JsonFile -Path $outputArtifactPath -Value $outputArtifact
        if ($null -ne $bootstrapAck) {
            $outputArtifact.bootstrapAck = [ordered]@{
                path = [string](Get-PropertyValue -Object $bootstrapAck -Name 'bootstrapStatusPath')
                stage = [string](Get-PropertyValue -Object (Get-PropertyValue -Object $bootstrapAck -Name 'bootstrap') -Name 'stage')
                status = [string](Get-PropertyValue -Object (Get-PropertyValue -Object $bootstrapAck -Name 'bootstrap') -Name 'status')
                sourceKind = 'bootstrap-live'
            }
            $outputArtifact.liveModelAccess = $liveModelAccess
            $outputArtifact.liveModelHeader = $liveModelHeader
            $outputArtifact.safeQueryProof = $safeQueryProof
            $outputArtifact.statsAvailable = ($null -ne $liveStats)
            $outputArtifact.stats = $liveStats
            Write-JsonFile -Path $outputArtifactPath -Value $outputArtifact
        }
        $resultSnapshotKind = if ($snapshotWritten) { 'model' } else { $null }
        $resultSnapshotSourceKind = if ($snapshotWritten) { 'live' } else { $null }
        $resultBootstrapAck = if ($null -ne $bootstrapAck) {
            [ordered]@{
                path = [string](Get-PropertyValue -Object $bootstrapAck -Name 'bootstrapStatusPath')
                stage = [string](Get-PropertyValue -Object (Get-PropertyValue -Object $bootstrapAck -Name 'bootstrap') -Name 'stage')
                status = [string](Get-PropertyValue -Object (Get-PropertyValue -Object $bootstrapAck -Name 'bootstrap') -Name 'status')
                artifact = Get-PropertyValue -Object $bootstrapAck -Name 'bootstrapStatus'
            }
        }
        else {
            $null
        }
        $resultBootstrap = if ($null -ne $bootstrapPlan) {
            [ordered]@{
                strategyKey = [string](Get-PropertyValue -Object $bootstrapPlan -Name 'strategyKey')
                ready = [bool](Get-PropertyValue -Object $bootstrapPlan -Name 'ready')
                invocation = Get-PropertyValue -Object $bootstrapPlan -Name 'invocation'
                artifacts = Get-PropertyValue -Object $bootstrapPlan -Name 'artifacts'
            }
        }
        else {
            $null
        }

        $resultSchemaValidation = @{
            attempted = [bool]$snapshotValidation.attempted
            schemaPath = 'contracts/model-snapshot.schema.json'
            valid = $snapshotValidation.valid
        }
        $response.result = [pscustomobject]@{
            artifactKind = 'sketchup-live-extraction-output'
            artifactPath = $outputArtifactPath
            snapshotPath = $null
            snapshotKind = $resultSnapshotKind
            snapshotSourceKind = $resultSnapshotSourceKind
            bootstrapAck = $resultBootstrapAck
            liveModelHeader = $liveModelHeader
            liveModelAccess = $liveModelAccess
            safeQueryProof = $safeQueryProof
            bootstrap = $resultBootstrap
            schemaValidation = $resultSchemaValidation
            stats = $liveStats
        }

        $response.result.snapshotPath = if ($snapshotWritten) { $snapshotArtifactPath } else { $null }
        if ($null -ne $outputArtifact) {
            $outputArtifact.validation.attempted = [bool]$snapshotValidation.attempted
            $outputArtifact.validation.valid = $snapshotValidation.valid
            $outputArtifact.validation.validator = $snapshotValidation.validator
            if ($snapshotWritten) {
                $outputArtifact.snapshot.path = $snapshotArtifactPath
            }
            Write-JsonFile -Path $outputArtifactPath -Value $outputArtifact
        }
    }

    Write-JsonFile -Path $responsePath -Value $response
}
catch {
    Write-Host "DEBUG-EXCEPTION:$($_.Exception.GetType().FullName):$($_.Exception.Message)"
    Write-Host "DEBUG-STACK:$($_.ScriptStackTrace)"
    $responsePath = if ([string]::IsNullOrWhiteSpace($responsePath)) { Get-RequestResponsePath -Request $request } else { $responsePath }
    if ([string]::IsNullOrWhiteSpace($responsePath)) {
        throw
    }

    $requestId = if ($null -ne $request -and (Test-HasProperty -Object $request -Name 'requestId')) { [string](Get-PropertyValue -Object $request -Name 'requestId') } else { 'unknown-request' }
    $action = if ($null -ne $request -and (Test-HasProperty -Object $request -Name 'action')) { [string](Get-PropertyValue -Object $request -Name 'action') } else { 'extract-model-snapshot' }

    $response = [ordered]@{
        kind = 'sketchup-live-extractor-response'
        contractVersion = '1.0.0'
        requestId = $requestId
        action = $action
        ok = $false
        executionState = 'failed-preflight'
        sourceKind = 'mock-extractor-stub'
        readOnly = $true
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        durations = [ordered]@{
            totalMs = [int](((Get-Date) - $startedAt).TotalMilliseconds)
            startupMs = $null
            documentOpenMs = $null
            snapshotWriteMs = $null
        }
        artifacts = [ordered]@{
            responseArtifactPath = $responsePath
            outputArtifactPath = $null
            snapshotOutputPath = $null
        }
        preflight = [ordered]@{
            status = 'blocked'
            bootstrapActionable = $false
            trueLiveExtractionReady = $false
            selectedStrategyKey = $null
            summary = [ordered]@{
                passed = 0
                warned = 0
                failed = 1
            }
            checks = @(
                [ordered]@{
                    key = 'preflight-exception'
                    category = 'request'
                    status = 'fail'
                    ok = $false
                    code = 'request-incomplete'
                    message = 'Extractor failed before a full preflight report could be produced.'
                    details = [ordered]@{
                        exception = $_.Exception.Message
                    }
                }
            )
            blockerCodes = @('request-incomplete')
            unsupportedReasons = @()
        }
        result = $null
        warnings = @()
        errors = @(
            [ordered]@{
                code = 'unexpected-extractor-error'
                message = $_.Exception.Message
                stage = 'preflight'
                retryable = $false
                details = $null
            }
        )
    }

    Write-JsonFile -Path $responsePath -Value $response
}
