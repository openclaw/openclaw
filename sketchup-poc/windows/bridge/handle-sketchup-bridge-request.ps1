param(
    [Parameter(Mandatory = $true)]
    [string]$RequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Test-MapHasKey {
    param(
        [AllowNull()]
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    if ($null -eq $Object) {
        return $false
    }

    if ($Object -is [System.Collections.IDictionary]) {
        return $Object.Contains($Key)
    }

    $psProperties = if ($null -ne $Object.PSObject) { @($Object.PSObject.Properties) } else { @() }
    return (@($psProperties | Where-Object { $_.Name -eq $Key }).Length -gt 0)
}

function Get-LiveModelStats {
    param(
        [AllowNull()]
        [object]$LiveModelAccess
    )

    if ($null -eq $LiveModelAccess) {
        return $null
    }

    $entityCount = if ((Test-MapHasKey -Object $LiveModelAccess -Key 'rootEntitiesAccessible') -and [bool]$LiveModelAccess.rootEntitiesAccessible -and (Test-MapHasKey -Object $LiveModelAccess -Key 'rootEntityCount') -and $null -ne $LiveModelAccess.rootEntityCount) {
        [int]$LiveModelAccess.rootEntityCount
    }
    else {
        $null
    }

    $sceneCount = if ((Test-MapHasKey -Object $LiveModelAccess -Key 'scenesAccessible') -and [bool]$LiveModelAccess.scenesAccessible -and (Test-MapHasKey -Object $LiveModelAccess -Key 'sceneCount') -and $null -ne $LiveModelAccess.sceneCount) {
        [int]$LiveModelAccess.sceneCount
    }
    else {
        $null
    }

    $selectionCount = if ((Test-MapHasKey -Object $LiveModelAccess -Key 'selectionAccessible') -and [bool]$LiveModelAccess.selectionAccessible -and (Test-MapHasKey -Object $LiveModelAccess -Key 'selectionCount') -and $null -ne $LiveModelAccess.selectionCount) {
        [int]$LiveModelAccess.selectionCount
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
        sourceKind = 'bootstrap-live-model-access'
    }
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

    $json = $Data | ConvertTo-Json -Depth 100
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function New-TempJsonPath {
    param([string]$Prefix)
    $fileName = '{0}-{1}.json' -f $Prefix, ([guid]::NewGuid().ToString('N'))
    return Join-Path ([System.IO.Path]::GetTempPath()) $fileName
}

function Get-RepoRoot {
    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}

function Get-SketchUpExecutableCandidates {
    param(
        [hashtable]$Payload = @{}
    )

    $candidates = New-Object System.Collections.Generic.List[string]

    if ((Test-MapHasKey -Object $Payload -Key 'options') -and $Payload.options -and (Test-MapHasKey -Object $Payload.options -Key 'sketchupExePath') -and $Payload.options.sketchupExePath) {
        $candidates.Add([string]$Payload.options.sketchupExePath) | Out-Null
    }

    $roots = @(
        'C:\Program Files\SketchUp'
    )

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }

        $matches = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object {
                @(
                    (Join-Path $_.FullName 'SketchUp.exe'),
                    (Join-Path $_.FullName 'SketchUp\SketchUp.exe')
                )
            } |
            Where-Object { Test-Path -LiteralPath $_ }

        foreach ($match in $matches) {
            $candidates.Add([string]$match) | Out-Null
        }
    }

    foreach ($fallback in @(
        'C:\Program Files\SketchUp\SketchUp 2026\SketchUp\SketchUp.exe',
        'C:\Program Files\SketchUp\SketchUp 2026\SketchUp.exe',
        'C:\Program Files\SketchUp\SketchUp 2025\SketchUp\SketchUp.exe',
        'C:\Program Files\SketchUp\SketchUp 2025\SketchUp.exe',
        'C:\Program Files\SketchUp\SketchUp 2024\SketchUp\SketchUp.exe',
        'C:\Program Files\SketchUp\SketchUp 2024\SketchUp.exe',
        'C:\Program Files\SketchUp\SketchUp 2023\SketchUp\SketchUp.exe',
        'C:\Program Files\SketchUp\SketchUp 2023\SketchUp.exe'
    )) {
        $candidates.Add($fallback) | Out-Null
    }

    return @($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Get-SketchUpDocumentHintFromWindowTitle {
    param(
        [string]$WindowTitle
    )

    if ([string]::IsNullOrWhiteSpace($WindowTitle)) {
        return $null
    }

    $trimmed = $WindowTitle.Trim()
    if ($trimmed -match '^(?<name>.+?)\s+-\s+SketchUp(?:\s+Pro)?(?:\s+\d{4})?$') {
        $name = $Matches['name'].Trim()
        if (-not [string]::IsNullOrWhiteSpace($name)) {
            return [ordered]@{
                detected = $true
                source = 'main-window-title'
                name = $name
                path = $null
            }
        }
    }

    if ($trimmed -match '(?<name>[^\\/:*?"<>|]+\.skp)\b') {
        return [ordered]@{
            detected = $true
            source = 'main-window-title'
            name = $Matches['name']
            path = $null
        }
    }

    return $null
}

function Get-SketchUpDocumentHintFromCommandLine {
    param(
        [string]$CommandLine
    )

    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return $null
    }

    $quotedMatches = [regex]::Matches($CommandLine, '"(?<path>[A-Za-z]:\\[^"]+?\.skp)"')
    if ($quotedMatches.Count -gt 0) {
        $path = [string]$quotedMatches[0].Groups['path'].Value
        return [ordered]@{
            detected = $true
            source = 'process-command-line'
            name = [System.IO.Path]::GetFileName($path)
            path = $path
        }
    }

    $plainMatches = [regex]::Matches($CommandLine, '(?<path>[A-Za-z]:\\[^\r\n"]+?\.skp)\b')
    if ($plainMatches.Count -gt 0) {
        $path = [string]$plainMatches[0].Groups['path'].Value
        return [ordered]@{
            detected = $true
            source = 'process-command-line'
            name = [System.IO.Path]::GetFileName($path)
            path = $path
        }
    }

    return $null
}

function Get-SketchUpRunningProcessDetails {
    $process = Get-Process -Name 'SketchUp' -ErrorAction SilentlyContinue |
        Sort-Object StartTime -Descending |
        Select-Object -First 1

    if (-not $process) {
        return $null
    }

    $path = $null
    $windowTitle = $null
    try {
        $path = $process.Path
    }
    catch {
        $path = $null
    }

    try {
        $windowTitle = $process.MainWindowTitle
    }
    catch {
        $windowTitle = $null
    }

    $commandLine = $null
    try {
        $cimProcess = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f [int]$process.Id) -ErrorAction Stop
        if ($cimProcess) {
            $commandLine = [string]$cimProcess.CommandLine
            if (-not $path -and $cimProcess.ExecutablePath) {
                $path = [string]$cimProcess.ExecutablePath
            }
        }
    }
    catch {
        $commandLine = $null
    }

    return [ordered]@{
        processId = [int]$process.Id
        processName = [string]$process.ProcessName
        executablePath = $path
        mainWindowTitle = $windowTitle
        commandLine = $commandLine
    }
}

function Invoke-LiveProbe {
    param(
        [hashtable]$Payload
    )

    $candidates = Get-SketchUpExecutableCandidates -Payload $Payload
    $installedPath = $null
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $installedPath = $candidate
            break
        }
    }

    $process = Get-SketchUpRunningProcessDetails
    $documentHint = $null
    if ($process) {
        $documentHint = Get-SketchUpDocumentHintFromCommandLine -CommandLine $process.commandLine
        if (-not $documentHint) {
            $documentHint = Get-SketchUpDocumentHintFromWindowTitle -WindowTitle $process.mainWindowTitle
        }
    }

    $status = 'unavailable'
    $reasonCode = 'sketchup-not-discoverable'
    $reason = 'SketchUp executable could not be discovered and no SketchUp process is running.'
    if ($process -and $documentHint) {
        $status = 'process-running-document-detected'
        $reasonCode = $null
        $reason = $null
    }
    elseif ($process) {
        $status = 'process-running-no-document'
        $reasonCode = 'document-not-detected'
        $reason = 'A SketchUp process is running, but no active document could be inferred from process metadata.'
    }
    elseif ($installedPath) {
        $status = 'available-no-process'
        $reasonCode = 'process-not-running'
        $reason = 'SketchUp appears installed or launchable, but no running SketchUp process was found.'
    }

    $versionHint = $null
    if ($installedPath -and $installedPath -match 'SketchUp\s+(?<version>\d{4})') {
        $versionHint = [string]$Matches['version']
    }

    return [ordered]@{
        attempted = $true
        source = 'windows-host-real'
        status = $status
        available = ($status -ne 'unavailable')
        launchable = [bool]$installedPath
        processRunning = [bool]$process
        documentDetected = [bool]$documentHint
        automationImplemented = $false
        reasonCode = $reasonCode
        reason = $reason
        details = [ordered]@{
            probeKind = 'real'
            candidateExecutablePaths = @($candidates)
            installedExecutablePath = $installedPath
            installedVersionHint = $versionHint
            runningProcessDetected = [bool]$process
            runningProcessId = if ($process) { [int]$process.processId } else { $null }
            runningExecutablePath = if ($process) { $process.executablePath } else { $null }
            runningMainWindowTitle = if ($process) { $process.mainWindowTitle } else { $null }
            runningCommandLine = if ($process) { $process.commandLine } else { $null }
            detectedDocument = if ($documentHint) { $documentHint } else {
                [ordered]@{
                    detected = $false
                    source = $null
                    name = $null
                    path = $null
                }
            }
            note = 'This phase only probes installation and process metadata. It does not attach to, inspect, or drive a live SketchUp session.'
        }
    }
}

function Get-LiveMetadataResultKind {
    param(
        [hashtable]$LiveProbe
    )

    if (-not $LiveProbe -or -not $LiveProbe.attempted) {
        return 'none'
    }

    $details = if ((Test-MapHasKey -Object $LiveProbe -Key 'details')) { $LiveProbe.details } else { $null }
    $hasAppHint = $false
    $hasDocumentHint = $false

    if ($details) {
        $hasAppHint = -not [string]::IsNullOrWhiteSpace([string]$details.installedExecutablePath) -or
            -not [string]::IsNullOrWhiteSpace([string]$details.runningExecutablePath) -or
            -not [string]::IsNullOrWhiteSpace([string]$details.installedVersionHint)

        if ((Test-MapHasKey -Object $details -Key 'detectedDocument') -and $details.detectedDocument) {
            $hasDocumentHint = [bool]$details.detectedDocument.detected
        }
    }

    if ($hasAppHint -or $hasDocumentHint -or $LiveProbe.processRunning -or $LiveProbe.documentDetected) {
        return 'real-minimal-metadata'
    }

    return 'real-probe-no-metadata'
}

function Build-MinimalLiveMetadata {
    param(
        [hashtable]$LiveProbe
    )

    $resultKind = Get-LiveMetadataResultKind -LiveProbe $LiveProbe
    if ($resultKind -ne 'real-minimal-metadata') {
        return $null
    }

    $details = if ((Test-MapHasKey -Object $LiveProbe -Key 'details')) { $LiveProbe.details } else { @{} }
    $document = if ((Test-MapHasKey -Object $details -Key 'detectedDocument') -and $details.detectedDocument) {
        $details.detectedDocument
    }
    else {
        @{
            detected = $false
            source = $null
            name = $null
            path = $null
        }
    }

    $appExecutablePath = if (-not [string]::IsNullOrWhiteSpace([string]$details.runningExecutablePath)) {
        [string]$details.runningExecutablePath
    }
    else {
        [string]$details.installedExecutablePath
    }

    $signals = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($appExecutablePath)) {
        $signals.Add('app-executable-path-hint') | Out-Null
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$details.installedVersionHint)) {
        $signals.Add('app-version-hint') | Out-Null
    }
    if ($LiveProbe.processRunning) {
        $signals.Add('process-running-detected') | Out-Null
    }
    if ($document.detected) {
        if (-not [string]::IsNullOrWhiteSpace([string]$document.name)) {
            $signals.Add('document-name-hint') | Out-Null
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$document.path)) {
            $signals.Add('document-path-hint') | Out-Null
        }
    }

    return [ordered]@{
        kind = 'real-minimal-metadata'
        source = 'windows-host-real'
        extractionKind = 'process-metadata-only'
        obtainedAtUtc = [DateTime]::UtcNow.ToString('o')
        signals = @($signals | Select-Object -Unique)
        app = [ordered]@{
            detected = [bool](-not [string]::IsNullOrWhiteSpace($appExecutablePath))
            executablePathHint = if (-not [string]::IsNullOrWhiteSpace($appExecutablePath)) { $appExecutablePath } else { $null }
            versionHint = if (-not [string]::IsNullOrWhiteSpace([string]$details.installedVersionHint)) { [string]$details.installedVersionHint } else { $null }
            processRunning = [bool]$LiveProbe.processRunning
            processId = if ($LiveProbe.processRunning -and $details.runningProcessId) { [int]$details.runningProcessId } else { $null }
            mainWindowTitleHint = if (-not [string]::IsNullOrWhiteSpace([string]$details.runningMainWindowTitle)) { [string]$details.runningMainWindowTitle } else { $null }
        }
        document = [ordered]@{
            detected = [bool]$document.detected
            source = if ($document.source) { [string]$document.source } else { $null }
            nameHint = if ($document.name) { [string]$document.name } else { $null }
            pathHint = if ($document.path) { [string]$document.path } else { $null }
        }
        model = [ordered]@{
            activeDocumentDetected = [bool]$document.detected
            activeModelDetected = [bool]$document.detected
        }
        limitations = @(
            'Derived from Windows process/install metadata only.',
            'Does not attach to a SketchUp session or read model entities.',
            'Document hints may come from process command line or window title and can be incomplete.'
        )
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

    $modelTitle = if ((Test-MapHasKey -Object $LiveModelAccess -Key 'modelTitle')) { $LiveModelAccess.modelTitle } else { $null }
    $modelPath = if ((Test-MapHasKey -Object $LiveModelAccess -Key 'modelPath')) { $LiveModelAccess.modelPath } else { $null }
    $modelGuid = if ((Test-MapHasKey -Object $LiveModelAccess -Key 'modelGuid')) { $LiveModelAccess.modelGuid } else { $null }
    $requestedDocumentMatched = if ((Test-MapHasKey -Object $LiveModelAccess -Key 'requestedDocumentMatched')) { $LiveModelAccess.requestedDocumentMatched } else { $null }

    if (-not $modelTitle -and -not $modelPath -and -not $modelGuid -and $null -eq $requestedDocumentMatched) {
        return $null
    }

    return [ordered]@{
        modelTitle = if ($modelTitle) { [string]$modelTitle } else { $null }
        modelPath = if ($modelPath) { [string]$modelPath } else { $null }
        modelGuid = if ($modelGuid) { [string]$modelGuid } else { $null }
        requestedDocumentMatched = if ($null -ne $requestedDocumentMatched) { [bool]$requestedDocumentMatched } else { $null }
        sourceKind = 'bootstrap-live-model-access'
        stats = $Stats
    }
}

function Build-LiveExtractionHandoffPlan {
    param(
        [string]$RequestId,
        [hashtable]$LiveProbe,
        [hashtable]$LiveMetadata,
        [hashtable]$Payload
    )

    if (-not $LiveProbe -or -not $LiveProbe.available -or -not $LiveProbe.documentDetected) {
        return $null
    }

    $details = if ((Test-MapHasKey -Object $LiveProbe -Key 'details')) { $LiveProbe.details } else { @{} }
    $document = if ($LiveMetadata -and (Test-MapHasKey -Object $LiveMetadata -Key 'document') -and $LiveMetadata.document) {
        $LiveMetadata.document
    }
    elseif ((Test-MapHasKey -Object $details -Key 'detectedDocument') -and $details.detectedDocument) {
        $details.detectedDocument
    }
    else {
        @{
            detected = $false
            source = $null
            name = $null
            path = $null
        }
    }

    $app = if ($LiveMetadata -and (Test-MapHasKey -Object $LiveMetadata -Key 'app') -and $LiveMetadata.app) {
        $LiveMetadata.app
    }
    else {
        @{
            detected = $false
            executablePathHint = if ($details.runningExecutablePath) { [string]$details.runningExecutablePath } else { [string]$details.installedExecutablePath }
            versionHint = if ($details.installedVersionHint) { [string]$details.installedVersionHint } else { $null }
            processRunning = [bool]$LiveProbe.processRunning
            processId = if ($details.runningProcessId) { [int]$details.runningProcessId } else { $null }
            mainWindowTitleHint = if ($details.runningMainWindowTitle) { [string]$details.runningMainWindowTitle } else { $null }
        }
    }

    $documentPathHint = if ($document.pathHint) { [string]$document.pathHint } elseif ($document.path) { [string]$document.path } else { $null }
    $documentNameHint = if ($document.nameHint) { [string]$document.nameHint } elseif ($document.name) { [string]$document.name } else { $null }
    $documentSource = if ($document.source) { [string]$document.source } else { $null }

    $responseArtifactPath = if ((Test-MapHasKey -Object $Payload -Key 'responseArtifactPath') -and $Payload.responseArtifactPath) {
        [string]$Payload.responseArtifactPath
    }
    else {
        'C:\OpenClaw\SketchUpPoC\live-extractor-response.json'
    }

    $snapshotOutputPath = if ((Test-MapHasKey -Object $Payload -Key 'snapshotOutputPath') -and $Payload.snapshotOutputPath) {
        [string]$Payload.snapshotOutputPath
    }
    else {
        'C:\OpenClaw\SketchUpPoC\live-model-snapshot.json'
    }

    $outputArtifactPath = [System.IO.Path]::ChangeExtension($responseArtifactPath, '.output.json')
    $strategyKey = 'ruby-startup-open-document'
    $extractorRequest = [ordered]@{
        kind = 'sketchup-live-extractor-request'
        contractVersion = '1.0.0'
        requestId = $RequestId
        requestedAtUtc = [DateTime]::UtcNow.ToString('o')
        action = 'extract-model-snapshot'
        readOnly = $true
        sourceKind = 'bridge-live-handoff'
        target = [ordered]@{
            sketchupExecutablePathHint = if ($app.executablePathHint) { [string]$app.executablePathHint } else { $null }
            sketchupVersionHint = if ($app.versionHint) { [string]$app.versionHint } else { $null }
            sketchupProcessId = if ($app.processId) { [int]$app.processId } else { $null }
            documentDetected = [bool]$LiveProbe.documentDetected
            documentNameHint = $documentNameHint
            documentPathHint = $documentPathHint
            documentSource = $documentSource
        }
        artifacts = [ordered]@{
            responseArtifactPath = $responseArtifactPath
            outputArtifactPath = $outputArtifactPath
            snapshotOutputPath = $snapshotOutputPath
        }
        strategy = [ordered]@{
            key = $strategyKey
            attachMode = if ($LiveProbe.processRunning) { 'launch-or-reuse' } else { 'launch-or-reuse' }
            startupMode = 'ruby-startup'
            notes = @(
                'Prefer launching SketchUp with a controlled RubyStartup/bootstrap entrypoint.',
                'If a compatible SketchUp process is already running, reuse is allowed only if the bootstrap path can still be applied safely.',
                'The extractor must stay read-only and emit schema-shaped JSON artifacts.'
            )
        }
        options = [ordered]@{
            documentPath = $documentPathHint
            documentName = $documentNameHint
            sketchupExePath = if ($app.executablePathHint) { [string]$app.executablePathHint } else { $null }
        }
        probeContext = [ordered]@{
            probeSource = 'windows-host-real'
            probeStatus = [string]$LiveProbe.status
            metadataResultKind = if ($LiveMetadata) { 'real-minimal-metadata' } else { 'real-probe-no-metadata' }
        }
    }

    return [ordered]@{
        kind = 'live-extraction-handoff-plan'
        contractVersion = '1.0.0'
        source = 'windows-host-real'
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        readOnly = $true
        automationImplemented = $false
        liveVsMock = [ordered]@{
            currentBridgeResult = 'live-handoff-plan'
            extractorImplementationState = 'not-implemented'
            snapshotResultIfExecutedNow = 'none'
            mockFallbackAvailable = $true
        }
        target = [ordered]@{
            sketchupProcessRunning = [bool]$LiveProbe.processRunning
            sketchupProcessId = if ($app.processId) { [int]$app.processId } else { $null }
            sketchupExecutablePathHint = if ($app.executablePathHint) { [string]$app.executablePathHint } else { $null }
            sketchupVersionHint = if ($app.versionHint) { [string]$app.versionHint } else { $null }
            documentDetected = [bool]$LiveProbe.documentDetected
            documentNameHint = $documentNameHint
            documentPathHint = $documentPathHint
            documentSource = $documentSource
        }
        proposedLiveCommand = [ordered]@{
            action = 'extract-model-snapshot'
            strategy = $strategyKey
            readOnly = $true
            options = [ordered]@{
                documentPath = $documentPathHint
                documentName = $documentNameHint
                sketchupExePath = if ($app.executablePathHint) { [string]$app.executablePathHint } else { $null }
            }
        }
        extractorContract = [ordered]@{
            requestSchema = 'contracts/live-extractor-request.schema.json'
            responseSchema = 'contracts/live-extractor-response.schema.json'
            outputArtifactSchema = 'contracts/live-extraction-output-artifact.schema.json'
            snapshotSchema = 'contracts/model-snapshot.schema.json'
        }
        extractorRequest = $extractorRequest
        expectedArtifacts = [ordered]@{
            responseArtifactPath = $responseArtifactPath
            outputArtifactPath = $outputArtifactPath
            snapshotOutputPath = $snapshotOutputPath
            snapshotSourceKind = 'live'
        }
        readiness = [ordered]@{
            status = 'ready-for-live-extractor'
            blockers = @()
            requirements = @(
                'Implement a real SketchUp-side extractor entrypoint.',
                'Open the detected document through a controlled RubyStartup/bootstrap path.',
                'Emit schema-shaped snapshot JSON from the live extractor instead of sample data.'
            )
        }
        failureModes = @(
            [ordered]@{
                code = 'live-extraction-not-implemented'
                stage = 'preflight'
                retryable = $false
                meaning = 'The bridge can prepare a live request, but no true live extractor entrypoint exists yet.'
            },
            [ordered]@{
                code = 'sketchup-not-installed'
                stage = 'preflight'
                retryable = $false
                meaning = 'The target host cannot find a launchable SketchUp installation.'
            },
            [ordered]@{
                code = 'document-open-failed'
                stage = 'document-open'
                retryable = $true
                meaning = 'SketchUp started but the requested document could not be opened through the chosen bootstrap path.'
            },
            [ordered]@{
                code = 'ruby-bootstrap-timeout'
                stage = 'ruby-bootstrap'
                retryable = $true
                meaning = 'The SketchUp-side Ruby bootstrap did not acknowledge readiness within the expected timeout.'
            },
            [ordered]@{
                code = 'snapshot-schema-invalid'
                stage = 'validation'
                retryable = $false
                meaning = 'A snapshot was emitted, but it did not validate against contracts/model-snapshot.schema.json.'
            }
        )
        strategyNotes = @(
            'Likely honest live path: start SketchUp with a controlled RubyStartup/bootstrap hook, open the target .skp document, then have Ruby emit snapshot JSON to the requested artifact paths.',
            'If SketchUp is already running, reuse is acceptable only if the bootstrap route can be injected or preconfigured without pretending attachment already works.',
            'The bridge remains probe-first; live extraction should consume this handoff request instead of bypassing the bridge contract.'
        )
        limitations = @(
            'This plan is derived from real Windows host probe data only.',
            'No live SketchUp automation session is attached or driven in this phase.',
            'No model entities, scenes, tags, or materials are read yet.'
        )
    }
}

function Convert-PayloadToExtractorCommand {
    param(
        [string]$RequestId,
        [hashtable]$Payload
    )

    $command = [ordered]@{
        requestId = $RequestId
        command = [string]$Payload.action
        options = @{}
    }

    if ((Test-MapHasKey -Object $Payload -Key 'snapshotOutputPath') -and $Payload.snapshotOutputPath) {
        $command.outputPath = [string]$Payload.snapshotOutputPath
    }

    if ((Test-MapHasKey -Object $Payload -Key 'options') -and $Payload.options) {
        $command.options = ConvertTo-Hashtable -Value $Payload.options
    }

    return $command
}

function Invoke-MockExtractor {
    param(
        [string]$RequestId,
        [hashtable]$Payload
    )

    $repoRoot = Get-RepoRoot
    $extractorPath = Join-Path $repoRoot 'windows\extractor\sketchup-extractor.ps1'
    $commandPath = New-TempJsonPath -Prefix 'sketchup-command'
    $responsePath = if ((Test-MapHasKey -Object $Payload -Key 'responseArtifactPath') -and $Payload.responseArtifactPath) {
        [string]$Payload.responseArtifactPath
    }
    else {
        New-TempJsonPath -Prefix 'sketchup-response'
    }

    $command = Convert-PayloadToExtractorCommand -RequestId $RequestId -Payload $Payload
    Write-JsonFile -Path $commandPath -Data $command

    & $extractorPath -CommandPath $commandPath -OutputPath $responsePath | Out-Null

    $response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    return [ordered]@{
        responsePath = $responsePath
        response = $response
    }
}

function Invoke-LiveBootstrapExtractor {
    param(
        [hashtable]$ExtractorRequest
    )

    $repoRoot = Get-RepoRoot
    $extractorPath = Join-Path $repoRoot 'windows\extractor\sketchup-live-extractor.ps1'
    $requestPath = New-TempJsonPath -Prefix 'sketchup-live-request'
    Write-JsonFile -Path $requestPath -Data $ExtractorRequest

    & $extractorPath -RequestPath $requestPath | Out-Null

    $responsePath = [string]$ExtractorRequest.artifacts.responseArtifactPath
    if (-not (Test-Path -LiteralPath $responsePath)) {
        throw "Live extractor did not materialize the expected response artifact: $responsePath"
    }

    $response = Get-Content -LiteralPath $responsePath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
    return [ordered]@{
        requestPath = $requestPath
        responsePath = $responsePath
        response = $response
    }
}

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
if (-not $request.requestId) {
    throw 'Bridge request is missing requestId.'
}
if (-not $request.payload) {
    throw 'Bridge request is missing payload.'
}

$payload = ConvertTo-Hashtable -Value $request.payload
$action = [string]$payload.action
if ([string]::IsNullOrWhiteSpace($action)) {
    throw 'SketchUp bridge payload.action is required.'
}

$probeMode = if ((Test-MapHasKey -Object $payload -Key 'probeMode') -and $payload.probeMode) { [string]$payload.probeMode } else { 'probe-first' }
$fallbackMode = if ((Test-MapHasKey -Object $payload -Key 'fallbackMode') -and $payload.fallbackMode) { [string]$payload.fallbackMode } else { 'mock-sample' }
$liveExtractorMode = if ((Test-MapHasKey -Object $payload -Key 'liveExtractorMode') -and $payload.liveExtractorMode) { [string]$payload.liveExtractorMode } else { 'handoff-plan' }
$warnings = New-Object System.Collections.Generic.List[string]

$liveProbe = [ordered]@{
    attempted = $false
    source = 'skipped'
    available = $false
    status = 'not-attempted'
    launchable = $false
    processRunning = $false
    documentDetected = $false
    automationImplemented = $false
    reasonCode = 'probe-skipped'
    reason = 'Probe was skipped by request.'
    details = [ordered]@{
        note = 'Probe was skipped by request.'
    }
}

if ($probeMode -eq 'probe-first') {
    $liveProbe = Invoke-LiveProbe -Payload $payload
    if ($liveProbe.status -eq 'unavailable') {
        $warnings.Add('Real SketchUp probe could not find an installed or running SketchUp instance. Probe details are included for transparency.') | Out-Null
    }
}

$liveMetadata = Build-MinimalLiveMetadata -LiveProbe $liveProbe
$metadataResultKind = Get-LiveMetadataResultKind -LiveProbe $liveProbe

if ($action -eq 'sketchup-ping' -or $action -eq 'get-minimal-live-metadata') {
    $resultKind = switch ($metadataResultKind) {
        'real-minimal-metadata' { 'real-minimal-metadata' }
        'real-probe-no-metadata' { 'real-probe-no-metadata' }
        default { 'none' }
    }
    $message = if ($liveMetadata) {
        'Bridge request reached the SketchUp PoC handler. Minimal live metadata hints were derived from real Windows host inspection; no SketchUp automation session is driven.'
    }
    elseif ($metadataResultKind -eq 'none') {
        'Bridge request reached the SketchUp PoC handler. Probe was skipped, so no real SketchUp availability or metadata signals were collected.'
    }
    else {
        'Bridge request reached the SketchUp PoC handler. The result is limited to real Windows host availability probing; no live metadata hints were obtainable and no SketchUp automation session is driven.'
    }

    return [ordered]@{
        action = $action
        readOnly = $true
        liveProbe = $liveProbe
        liveMetadata = $liveMetadata
        execution = [ordered]@{
            mode = if ($action -eq 'get-minimal-live-metadata') { 'metadata-only' } else { 'probe-only' }
            usedFallback = $false
            fallbackReason = $null
            extractorContractKind = 'none'
            probeResultKind = if ($liveProbe.attempted) { 'real' } else { 'none' }
            metadataResultKind = $metadataResultKind
            snapshotResultKind = 'none'
            resultKind = $resultKind
        }
        result = [ordered]@{
            bridgeReachable = $true
            extractorAvailable = (Test-Path -LiteralPath (Join-Path (Get-RepoRoot) 'windows\extractor\sketchup-extractor.ps1'))
            sketchupAutomationImplemented = $false
            liveExtractionImplemented = $false
            metadataAvailable = [bool]$liveMetadata
            metadataSource = if ($liveMetadata) { 'windows-host-real' } else { $null }
            liveMetadata = $liveMetadata
            message = $message
        }
        warnings = @($warnings)
    }
}

if ($action -ne 'extract-model-snapshot') {
    throw "Unsupported SketchUp bridge action: $action"
}

$liveHandoffPlan = Build-LiveExtractionHandoffPlan -RequestId ([string]$request.requestId) -LiveProbe $liveProbe -LiveMetadata $liveMetadata -Payload $payload

if ($liveHandoffPlan) {
    if ($liveExtractorMode -eq 'execute-bootstrap-ack') {
        $liveExecution = Invoke-LiveBootstrapExtractor -ExtractorRequest $liveHandoffPlan.extractorRequest
        $liveResponse = $liveExecution.response
        $liveResult = if ((Test-MapHasKey -Object $liveResponse -Key 'result')) { $liveResponse.result } else { $null }
        $bootstrapAck = if ($liveResult -and (Test-MapHasKey -Object $liveResult -Key 'bootstrapAck')) { $liveResult.bootstrapAck } else { $null }
        $liveModelHeader = if ($liveResult -and (Test-MapHasKey -Object $liveResult -Key 'liveModelHeader')) { $liveResult.liveModelHeader } else { $null }
        $liveModelAccess = if ($liveResult -and (Test-MapHasKey -Object $liveResult -Key 'liveModelAccess')) { $liveResult.liveModelAccess } else { $null }
        $safeQueryProof = if ($liveResult -and (Test-MapHasKey -Object $liveResult -Key 'safeQueryProof')) { $liveResult.safeQueryProof } else { $null }
        $liveStats = Get-LiveModelStats -LiveModelAccess $liveModelAccess
        if (-not $liveModelHeader) {
            $liveModelHeader = Get-LiveModelHeader -LiveModelAccess $liveModelAccess -Stats $liveStats
        }
        $warnings.Add('Live probe data was handed off into the live extractor for a real bootstrap acknowledgment attempt.') | Out-Null
        if ($liveResponse.warnings) {
            foreach ($warning in $liveResponse.warnings) {
                $warnings.Add([string]$warning) | Out-Null
            }
        }

        return [ordered]@{
            action = $action
            readOnly = $true
            liveProbe = $liveProbe
            liveMetadata = $liveMetadata
            execution = [ordered]@{
                mode = 'bootstrap-ack'
                usedFallback = $false
                fallbackReason = $null
                extractorContractKind = 'sketchup-live-extractor-request'
                probeResultKind = if ($liveProbe.attempted) { 'real' } else { 'none' }
                metadataResultKind = $metadataResultKind
                snapshotResultKind = 'none'
                resultKind = if ($liveResponse.executionState) { [string]$liveResponse.executionState } else { 'bootstrap-ack' }
                liveExtractorResponsePath = [string]$liveExecution.responsePath
            }
            result = [ordered]@{
                liveMetadata = $liveMetadata
                liveMetadataAvailable = [bool]$liveMetadata
                snapshotPath = $null
                snapshotKind = 'none'
                resultSource = if ($liveResponse.executionState -eq 'succeeded-live-model-access') { 'live-model-access' } else { 'live-bootstrap-ack' }
                bootstrapAck = $bootstrapAck
                liveModelHeader = $liveModelHeader
                liveModelAccess = $liveModelAccess
                safeQueryProof = $safeQueryProof
                liveModelStats = $liveStats
                liveExtractionPlan = $liveHandoffPlan
                liveExtractorResponse = $liveResponse
                message = if ($liveResponse.executionState -eq 'succeeded-live-model-access') {
                    'Real probe data triggered the live extractor and the Ruby bootstrap proved access to Sketchup.active_model.'
                }
                elseif ($bootstrapAck) {
                    'Real probe data triggered the live extractor and a SketchUp-side bootstrap acknowledgment artifact was observed.'
                }
                else {
                    'Real probe data triggered the live extractor, but no SketchUp-side bootstrap acknowledgment artifact was observed.'
                }
            }
            warnings = @($warnings | Select-Object -Unique)
        }
    }

    $warnings.Add('Returning a live extraction handoff plan from real probe data. No snapshot was extracted yet.') | Out-Null
    return [ordered]@{
        action = $action
        readOnly = $true
        liveProbe = $liveProbe
        liveMetadata = $liveMetadata
        execution = [ordered]@{
            mode = 'live-handoff-plan'
            usedFallback = $false
            fallbackReason = $null
            extractorContractKind = 'sketchup-live-extractor-request'
            probeResultKind = if ($liveProbe.attempted) { 'real' } else { 'none' }
            metadataResultKind = $metadataResultKind
            snapshotResultKind = 'live-handoff-plan'
            resultKind = 'live-handoff-plan'
        }
        result = [ordered]@{
            liveMetadata = $liveMetadata
            liveMetadataAvailable = [bool]$liveMetadata
            snapshotPath = $null
            snapshotKind = 'none'
            resultSource = 'live-handoff-plan'
            liveExtractionPlan = $liveHandoffPlan
            message = 'Real probe data identified a candidate live SketchUp document. This phase returns a handoff plan for the future live extractor instead of a snapshot.'
        }
        warnings = @($warnings)
    }
}

if ($liveProbe.available -and $fallbackMode -eq 'live-only') {
    throw 'Live SketchUp extraction is not implemented yet. A real SketchUp target was detected, so only a handoff plan can be returned in this phase.'
}

if ($fallbackMode -ne 'mock-sample') {
    throw 'Live SketchUp extraction is unavailable and fallbackMode does not allow mock-sample fallback.'
}

$warnings.Add('Returning mock/sample snapshot because live SketchUp automation is not implemented in this phase.') | Out-Null
$mock = Invoke-MockExtractor -RequestId ([string]$request.requestId) -Payload $payload
$mockResponse = $mock.response
$snapshotPath = $null
if ((Test-MapHasKey -Object $mockResponse -Key 'result') -and $mockResponse.result -and (Test-MapHasKey -Object $mockResponse.result -Key 'snapshotPath')) {
    $snapshotPath = [string]$mockResponse.result.snapshotPath
}

return [ordered]@{
    action = $action
    readOnly = $true
    liveProbe = $liveProbe
    liveMetadata = $liveMetadata
    execution = [ordered]@{
        mode = 'mock-fallback'
        usedFallback = $true
        fallbackReason = 'live-sketchup-unavailable'
        extractorContractKind = 'none'
        probeResultKind = if ($liveProbe.attempted) { 'real' } else { 'none' }
        metadataResultKind = $metadataResultKind
        snapshotResultKind = 'mock-fallback'
        resultKind = 'mock-fallback'
        extractorResponsePath = [string]$mock.responsePath
    }
    result = [ordered]@{
        liveMetadata = $liveMetadata
        liveMetadataAvailable = [bool]$liveMetadata
        snapshotPath = $snapshotPath
        snapshotKind = if ($mockResponse.result) { [string]$mockResponse.result.snapshotKind } else { 'model' }
        resultSource = 'mock-sample'
        mockExtractorResponse = $mockResponse
    }
    warnings = @($warnings)
}
