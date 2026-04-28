param(
    [Parameter(Mandatory = $true)]
    [string]$CommandPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RepoPath {
    param(
        [string[]]$Segments
    )

    $base = Split-Path -Parent $PSScriptRoot
    $base = Split-Path -Parent $base

    $path = $base
    foreach ($segment in $Segments) {
        $path = Join-Path -Path $path -ChildPath $segment
    }

    return $path
}

function Ensure-ParentDirectory {
    param(
        [string]$Path
    )

    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

function Read-JsonFile {
    param(
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "File not found: $Path"
    }

    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -Depth 100)
}

function Write-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )

    Ensure-ParentDirectory -Path $Path
    $Value | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function ConvertTo-Hashtable {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [string] -or $Value -is [char] -or $Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal] -or $Value -is [datetime] -or $Value -is [guid]) {
        return $Value
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $hash = @{}
        foreach ($key in $Value.Keys) {
            $hash[$key] = ConvertTo-Hashtable -Value $Value[$key]
        }
        return $hash
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @()
        foreach ($item in $Value) {
            $items += ,(ConvertTo-Hashtable -Value $item)
        }
        return $items
    }

    $psProperties = if ($null -ne $Value.PSObject) { @($Value.PSObject.Properties) } else { @() }
    if (@($psProperties).Length -gt 0) {
        $hash = @{}
        foreach ($property in $psProperties) {
            $hash[$property.Name] = ConvertTo-Hashtable -Value $property.Value
        }
        return $hash
    }

    return $Value
}

function Clone-Object {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 100
    return ConvertTo-Hashtable -Value ($json | ConvertFrom-Json -Depth 100)
}

function Get-SampleSnapshot {
    $samplePath = Resolve-RepoPath -Segments @('samples', 'sample-model-snapshot.json')
    return ConvertTo-Hashtable -Value (Read-JsonFile -Path $samplePath)
}

function Get-Capabilities {
    $capabilitiesPath = Resolve-RepoPath -Segments @('contracts', 'extraction-capabilities.json')
    $capabilities = ConvertTo-Hashtable -Value (Read-JsonFile -Path $capabilitiesPath)
    $capabilities.integrationMode = 'mock'
    $capabilities.sketchupAutomationImplemented = $false
    return $capabilities
}

function Has-Property {
    param(
        [AllowNull()]
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $Object) {
        return $false
    }

    if ($Object -is [System.Collections.IDictionary]) {
        return $Object.Contains($Name)
    }

    if ($null -eq $Object.PSObject) {
        return $false
    }

    return (@($Object.PSObject.Properties | Where-Object { $_.Name -eq $Name }).Length -gt 0)
}

function Get-RequestOption {
    param(
        [object]$Request,
        [string]$Name,
        $DefaultValue
    )

    if ($null -eq $Request.options) {
        return $DefaultValue
    }

    if (-not (Has-Property -Object $Request.options -Name $Name)) {
        return $DefaultValue
    }

    if ($Request.options -is [System.Collections.IDictionary]) {
        return $Request.options[$Name]
    }

    return $Request.options.$Name
}

function New-Response {
    param(
        [object]$Request
    )

    $requestId = 'req-mock'
    if (Has-Property -Object $Request -Name 'requestId') {
        $requestId = [string]$Request.requestId
    }

    $commandName = $null
    if (Has-Property -Object $Request -Name 'command') {
        $commandName = [string]$Request.command
    }

    return @{
        requestId = $requestId
        command = $commandName
        ok = $true
        mode = 'mock'
        readOnly = $true
        generatedAt = [DateTime]::UtcNow.ToString('o')
        warnings = @()
        errors = @()
    }
}

function Set-SnapshotMetadata {
    param(
        [hashtable]$Snapshot,
        [object]$Request,
        [string]$SnapshotKind
    )

    $Snapshot.source.appVersion = 'mock-extractor'
    $Snapshot.source.capturedAt = [DateTime]::UtcNow.ToString('o')
    $Snapshot.source.captureMode = 'manual'
    $Snapshot.source.readOnly = $true

    $documentName = Get-RequestOption -Request $Request -Name 'documentName' -DefaultValue $null
    if (-not [string]::IsNullOrWhiteSpace($documentName)) {
        $Snapshot.source.documentName = [string]$documentName
    }

    $documentPath = Get-RequestOption -Request $Request -Name 'documentPath' -DefaultValue $null
    if (-not [string]::IsNullOrWhiteSpace($documentPath)) {
        $Snapshot.source.documentPath = [string]$documentPath
    }
}

function Get-SelectionEntityIds {
    param(
        [hashtable]$Snapshot,
        [object]$Request
    )

    $requestedIds = Get-RequestOption -Request $Request -Name 'selectionEntityIds' -DefaultValue $null
    if ($null -ne $requestedIds) {
        return @($requestedIds | ForEach-Object { [string]$_ })
    }

    return @($Snapshot.selection.entityIds | ForEach-Object { [string]$_ })
}

function Build-SelectionSnapshot {
    param(
        [hashtable]$BaseSnapshot,
        [object]$Request
    )

    $snapshot = Clone-Object -Value $BaseSnapshot
    Set-SnapshotMetadata -Snapshot $snapshot -Request $Request -SnapshotKind 'selection'

    $selectedIds = Get-SelectionEntityIds -Snapshot $snapshot -Request $Request
    $selectedEntities = @($snapshot.entities | Where-Object { $selectedIds -contains [string]$_.id })

    $snapshot.entities = $selectedEntities
    $snapshot.selection = @{
        count = @($selectedEntities).Length
        entityIds = @($selectedEntities | ForEach-Object { [string]$_.id })
    }
    $snapshot.model.entityCount = @($selectedEntities).Length
    $snapshot.model.componentInstanceCount = @($selectedEntities | Where-Object { $_.kind -eq 'component_instance' }).Length
    $snapshot.model.groupCount = @($selectedEntities | Where-Object { $_.kind -eq 'group' }).Length

    return $snapshot
}

function Build-ModelSnapshot {
    param(
        [hashtable]$BaseSnapshot,
        [object]$Request
    )

    $snapshot = Clone-Object -Value $BaseSnapshot
    Set-SnapshotMetadata -Snapshot $snapshot -Request $Request -SnapshotKind 'model'
    return $snapshot
}

function Get-SnapshotOutputPath {
    param(
        [object]$Request,
        [string]$ResponsePath,
        [string]$DefaultFileName
    )

    $requestedOutputPath = $null
    if (Has-Property -Object $Request -Name 'outputPath') {
        $requestedOutputPath = [string]$Request.outputPath
    }

    if (-not [string]::IsNullOrWhiteSpace($requestedOutputPath)) {
        return $requestedOutputPath
    }

    $responseDirectory = Split-Path -Parent $ResponsePath
    if ([string]::IsNullOrWhiteSpace($responseDirectory)) {
        $responseDirectory = (Get-Location).Path
    }

    return Join-Path -Path $responseDirectory -ChildPath $DefaultFileName
}

function New-Stats {
    param(
        [hashtable]$Snapshot,
        [int]$DurationMs
    )

    return @{
        entityCount = [int]$Snapshot.model.entityCount
        sceneCount = [int]$Snapshot.model.sceneCount
        selectionCount = [int]$Snapshot.selection.count
        durationMs = $DurationMs
    }
}

$startedAt = Get-Date
$request = Read-JsonFile -Path $CommandPath
$response = New-Response -Request $request

try {
    if (-not (Has-Property -Object $request -Name 'command') -or [string]::IsNullOrWhiteSpace([string]$request.command)) {
        throw 'command is required in the request JSON.'
    }

    $baseSnapshot = Get-SampleSnapshot
    $commandName = [string]$request.command

    switch ($commandName) {
        'ping-sketchup' {
            $response.result = @{
                extractorReady = $true
                integrationMode = 'mock'
                sketchupReachable = $false
                sketchupAutomationImplemented = $false
                message = 'Mock extractor is reachable. Live SketchUp automation is not implemented in this PoC.'
            }
            $response.warnings += 'No live SketchUp process was queried. This command only verifies the mock extractor contract.'
        }
        'get-extraction-capabilities' {
            $response.result = Get-Capabilities
            $response.warnings += 'Capabilities describe the intended contract surface. Live SketchUp probing is not implemented yet.'
        }
        'extract-model-snapshot' {
            $snapshot = Build-ModelSnapshot -BaseSnapshot $baseSnapshot -Request $request
            $snapshotPath = Get-SnapshotOutputPath -Request $request -ResponsePath $OutputPath -DefaultFileName 'model-snapshot.json'
            Write-JsonFile -Path $snapshotPath -Value $snapshot

            $response.result = @{
                snapshotPath = $snapshotPath
                snapshotKind = 'model'
                stats = New-Stats -Snapshot $snapshot -DurationMs ([int](((Get-Date) - $startedAt).TotalMilliseconds))
            }
            $response.warnings += 'Snapshot content is seeded from the sample file; no live SketchUp session was read.'
        }
        'extract-selection-snapshot' {
            $snapshot = Build-SelectionSnapshot -BaseSnapshot $baseSnapshot -Request $request
            $snapshotPath = Get-SnapshotOutputPath -Request $request -ResponsePath $OutputPath -DefaultFileName 'selection-snapshot.json'
            Write-JsonFile -Path $snapshotPath -Value $snapshot

            $response.result = @{
                snapshotPath = $snapshotPath
                snapshotKind = 'selection'
                stats = New-Stats -Snapshot $snapshot -DurationMs ([int](((Get-Date) - $startedAt).TotalMilliseconds))
            }
            $response.warnings += 'Selection snapshot is derived from sample data; requested IDs outside the sample are ignored.'
        }
        default {
            throw "Unsupported command: $commandName"
        }
    }
}
catch {
    $response.ok = $false
    $response.errors += $_.Exception.Message
}

Write-JsonFile -Path $OutputPath -Value $response

if ($response.ok) {
    Write-Output "Response written to $OutputPath"
}
else {
    Write-Error "Extractor request failed. See response JSON at $OutputPath"
}
