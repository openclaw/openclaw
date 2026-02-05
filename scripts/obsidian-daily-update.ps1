[CmdletBinding()]
param(
    [switch]$DryRun,
    [int]$Limit = 0
)

# Obsidian 00.DAILY Frontmatter and Backlink Updater
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$dailyDir = 'C:\Users\jini9\OneDrive\Documents\JINI_SYNC\00.DAILY'

# ============================================================
# 1. PROJECT / TAG MAPPING
# ============================================================
$projectMappings = @(
    @{ Pattern = 'Enhanced C.E|C.E';   Project = "C`&E-$('{0}' -f '자동화')";  Tags = @("C`&E",'삼성엔지니어링') }
    @{ Pattern = 'MAIOSS';             Project = 'MAIOSS';       Tags = @('MAIOSS','오픈소스보안') }
    @{ Pattern = '\bAX\b';             Project = 'AX-표준데이터'; Tags = @('AX','데이터표준') }
    @{ Pattern = '\bn8n\b';            Project = 'n8n-자동화';   Tags = @('n8n','자동화') }
    @{ Pattern = 'MAIBEAUTY|베트남|BnF|뷰티'; Project = '베트남화장품'; Tags = @('베트남','화장품') }
    @{ Pattern = '\bIBK\b';            Project = 'IBK-AI';       Tags = @('IBK','인공지능') }
    @{ Pattern = 'P.ID|PnID|MAIPnID';  Project = "P`&ID-인식";   Tags = @("P`&ID",'삼성엔지니어링') }
    @{ Pattern = 'MAITHINK';           Project = 'MAITHINK';     Tags = @('MAITHINK') }
    @{ Pattern = 'MAISTT';             Project = 'MAISTT';       Tags = @('MAISTT','음성인식') }
    @{ Pattern = '데이터스크|IR Pitch'; Project = '데이터스크';    Tags = @('데이터스크','IR') }
    @{ Pattern = '\bRPM\b|BallTracking|골프'; Project = '볼트래킹'; Tags = @('골프','볼트래킹') }
)

$tagOnlyMappings = @(
    @{ Pattern = '\bRAG\b';               Tags = @('RAG') }
    @{ Pattern = '\bLLM\b|LLaMa|DeepSeek'; Tags = @('LLM') }
    @{ Pattern = 'Claude|chatGPT|\bGPT\b'; Tags = @('AI도구') }
    @{ Pattern = '\bMCP\b';               Tags = @('MCP') }
    @{ Pattern = '\bOCR\b';               Tags = @('OCR') }
    @{ Pattern = 'MLOps|LLMOps';          Tags = @('MLOps') }
    @{ Pattern = 'Neo4j|GraphRAG';        Tags = @('GraphRAG') }
    @{ Pattern = 'Obsidian';              Tags = @('Obsidian') }
    @{ Pattern = '삼성|Samsung';           Tags = @('삼성엔지니어링') }
    @{ Pattern = '캠퍼스';                 Tags = @('캠퍼스') }
)

# ============================================================
# 2. HELPER FUNCTIONS
# ============================================================

function Parse-Filename {
    param([string]$Name)
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($Name)
    if ($baseName -match '^(\d{4}-\d{2}-\d{2})\s*[-_ ]+\s*(.+)$') {
        return @{ Date = $Matches[1]; Title = $Matches[2].Trim() }
    }
    elseif ($baseName -match '^(\d{4}-\d{2})_(\d{2})[-_ ]+(.+)$') {
        return @{ Date = "$($Matches[1])-$($Matches[2])"; Title = $Matches[3].Trim() }
    }
    elseif ($baseName -match '^(\d{4}-\d{2}-\d{2})$') {
        return @{ Date = $Matches[1]; Title = '' }
    }
    return $null
}

function Parse-Frontmatter {
    param([string[]]$Lines)
    if ($Lines.Count -lt 2 -or $Lines[0].Trim() -ne '---') {
        return @{ HasFrontmatter = $false; FrontmatterEnd = -1; Properties = @{}; RawLines = @() }
    }
    $endIdx = -1
    for ($i = 1; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i].Trim() -eq '---') { $endIdx = $i; break }
    }
    if ($endIdx -eq -1) {
        return @{ HasFrontmatter = $false; FrontmatterEnd = -1; Properties = @{}; RawLines = @() }
    }
    $props = [ordered]@{}
    $currentKey = $null
    $currentList = $null
    $rawLines = $Lines[1..($endIdx-1)]
    foreach ($line in $rawLines) {
        if ($line -match '^\s+-\s+(.+)$') {
            if ($null -ne $currentKey -and $null -ne $currentList) {
                $val = $Matches[1].Trim()
                $val = $val.Trim('"').Trim("'")
                $currentList += $val
            }
        }
        elseif ($line -match '^(\w[\w_]*)\s*:\s*(.*)$') {
            if ($null -ne $currentKey -and $null -ne $currentList) {
                $props[$currentKey] = $currentList
            }
            $currentKey = $Matches[1]
            $value = $Matches[2].Trim()
            if ($value -eq '') {
                $currentList = @()
            } else {
                $currentList = $null
                $props[$currentKey] = $value.Trim('"').Trim("'")
            }
        }
    }
    if ($null -ne $currentKey -and $null -ne $currentList) {
        $props[$currentKey] = $currentList
    }
    return @{ HasFrontmatter = $true; FrontmatterEnd = $endIdx; Properties = $props; RawLines = $rawLines }
}

function Build-Frontmatter {
    param($Props)
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('---')
    foreach ($key in $Props.Keys) {
        $val = $Props[$key]
        if ($val -is [array]) {
            $lines.Add("${key}:")
            foreach ($item in $val) {
                if ($item -match '^#') {
                    $lines.Add("  - `"$item`"")
                } else {
                    $lines.Add("  - $item")
                }
            }
        } else {
            $lines.Add("${key}: $val")
        }
    }
    $lines.Add('---')
    return $lines.ToArray()
}

function Get-MatchedProjectAndTags {
    param([string]$Filename)
    $project = $null
    $newTags = [System.Collections.Generic.List[string]]::new()
    foreach ($m in $projectMappings) {
        if ($Filename -match $m.Pattern) {
            if (-not $project) { $project = $m.Project }
            foreach ($t in $m.Tags) {
                if (-not $newTags.Contains($t)) { $newTags.Add($t) }
            }
        }
    }
    foreach ($m in $tagOnlyMappings) {
        if ($Filename -match $m.Pattern) {
            foreach ($t in $m.Tags) {
                if (-not $newTags.Contains($t)) { $newTags.Add($t) }
            }
        }
    }
    return @{ Project = $project; Tags = $newTags.ToArray() }
}

function Merge-Tags {
    param([array]$Existing, [array]$New)
    $merged = [System.Collections.Generic.List[string]]::new()
    foreach ($t in $Existing) {
        $clean = $t.TrimStart('#').Trim()
        $found = $false
        foreach ($m in $merged) { if ($m.TrimStart('#').Trim() -eq $clean) { $found = $true; break } }
        if (-not $found) { $merged.Add($t) }
    }
    foreach ($t in $New) {
        $clean = $t.TrimStart('#').Trim()
        $found = $false
        foreach ($m in $merged) { if ($m.TrimStart('#').Trim() -eq $clean) { $found = $true; break } }
        if (-not $found) { $merged.Add($t) }
    }
    return $merged.ToArray()
}

# ============================================================
# 3. MAIN PROCESSING
# ============================================================

$files = Get-ChildItem $dailyDir -Filter '*.md' | Sort-Object Name
if ($Limit -gt 0) { $files = $files | Select-Object -First $Limit }

$totalFiles = @($files).Count
$processed = 0
$skipped = 0
$fmAdded = 0
$fmUpdated = 0
$titleFixed = 0
$tagsAdded = 0
$projectSet = 0
$backlinksAdded = 0
$projectCounts = @{}

$fileInfoList = [System.Collections.Generic.List[hashtable]]::new()

Write-Host '=== Obsidian Daily Notes Updater ===' -ForegroundColor Cyan
Write-Host "Directory: $dailyDir"
Write-Host "Files found: $totalFiles"
if ($DryRun) { Write-Host '[DRY RUN MODE - no files will be modified]' -ForegroundColor Yellow }
Write-Host ''

foreach ($file in $files) {
    $parsed = Parse-Filename $file.Name
    if (-not $parsed) {
        Write-Host "  SKIP (bad filename): $($file.Name)" -ForegroundColor Yellow
        $skipped++
        continue
    }
    $fileDate = $parsed.Date
    $fileTitle = $parsed.Title

    try {
        $lines = [System.IO.File]::ReadAllLines($file.FullName, [System.Text.Encoding]::UTF8)
    } catch {
        Write-Host "  SKIP (read error): $($file.Name)" -ForegroundColor Red
        $skipped++
        continue
    }

    $fm = Parse-Frontmatter $lines
    $match = Get-MatchedProjectAndTags $file.Name
    $changed = $false

    if ($fm.HasFrontmatter) {
        $props = $fm.Properties

        # Fix title
        $currentTitle = if ($props.Contains('title')) { $props['title'] } else { $null }
        if (-not $currentTitle -or $currentTitle -match 'tp\.file\.title') {
            $props['title'] = $fileTitle
            $changed = $true
            $titleFixed++
        }

        # Fix create_time
        if ($props.Contains('create_time')) {
            if ($props['create_time'] -ne $fileDate) {
                $props['create_time'] = $fileDate
                $changed = $true
            }
        } else {
            $props['create_time'] = $fileDate
            $changed = $true
        }

        # Merge tags
        $existingTags = @()
        if ($props.Contains('tags') -and $props['tags'] -is [array]) {
            $existingTags = $props['tags']
        }
        $mergedTags = Merge-Tags $existingTags $match.Tags
        if ($mergedTags.Count -gt $existingTags.Count) {
            $tagsAdded += ($mergedTags.Count - $existingTags.Count)
            $changed = $true
        }
        $props['tags'] = $mergedTags

        # Set project
        if ($match.Project -and (-not $props.Contains('project') -or -not $props['project'])) {
            $props['project'] = $match.Project
            $projectSet++
            $changed = $true
        }
        if ($match.Project) {
            if (-not $projectCounts.Contains($match.Project)) { $projectCounts[$match.Project] = 0 }
            $projectCounts[$match.Project]++
        }

        if ($changed) {
            $orderedProps = [ordered]@{}
            foreach ($key in @('title','type','create_time','update_time','tags','project','aliases')) {
                if ($props.Contains($key)) { $orderedProps[$key] = $props[$key] }
            }
            foreach ($key in $props.Keys) {
                if (-not $orderedProps.Contains($key)) { $orderedProps[$key] = $props[$key] }
            }
            $newFM = Build-Frontmatter $orderedProps
            $bodyLines = if ($fm.FrontmatterEnd -lt ($lines.Count - 1)) { $lines[($fm.FrontmatterEnd + 1)..($lines.Count - 1)] } else { @() }
            $newContent = ($newFM + $bodyLines) -join "`n"
            if (-not $DryRun) {
                [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.UTF8Encoding]::new($false))
            }
            $fmUpdated++
        }
    } else {
        $newProps = [ordered]@{}
        $newProps['title'] = $fileTitle
        $newProps['type'] = 'Daily Note'
        $newProps['create_time'] = $fileDate
        $tagsList = [System.Collections.Generic.List[string]]::new()
        $tagsList.Add('#daily')
        foreach ($t in $match.Tags) { if ($t -ne 'daily') { $tagsList.Add($t) } }
        $newProps['tags'] = $tagsList.ToArray()
        $tagsAdded += $tagsList.Count
        if ($match.Project) {
            $newProps['project'] = $match.Project
            $projectSet++
            if (-not $projectCounts.Contains($match.Project)) { $projectCounts[$match.Project] = 0 }
            $projectCounts[$match.Project]++
        }
        $newProps['aliases'] = @()
        $newFM = Build-Frontmatter $newProps
        $newContent = ($newFM + @('') + $lines) -join "`n"
        if (-not $DryRun) {
            [System.IO.File]::WriteAllText($file.FullName, $newContent, [System.Text.UTF8Encoding]::new($false))
        }
        $fmAdded++
    }

    $fileInfoList.Add(@{
        Name = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        FullPath = $file.FullName
        Date = $fileDate
        Project = $match.Project
    })
    $processed++
    if ($processed % 100 -eq 0) { Write-Host "  ... processed $processed files" }
}

# ============================================================
# 4. BACKLINK PHASE
# ============================================================
Write-Host ''
Write-Host '=== Phase 2: Adding Backlinks ===' -ForegroundColor Cyan

$projectGroups = @{}
foreach ($fi in $fileInfoList) {
    if ($fi.Project) {
        if (-not $projectGroups.Contains($fi.Project)) {
            $projectGroups[$fi.Project] = [System.Collections.Generic.List[hashtable]]::new()
        }
        $projectGroups[$fi.Project].Add($fi)
    }
}

foreach ($projName in $projectGroups.Keys) {
    $group = $projectGroups[$projName]
    foreach ($fi in $group) {
        try { $fiDate = [datetime]::ParseExact($fi.Date, 'yyyy-MM-dd', $null) } catch { continue }
        $related = [System.Collections.Generic.List[hashtable]]::new()
        foreach ($other in $group) {
            if ($other.Name -eq $fi.Name) { continue }
            try { $otherDate = [datetime]::ParseExact($other.Date, 'yyyy-MM-dd', $null) } catch { continue }
            if ([math]::Abs(($fiDate - $otherDate).TotalDays) -le 7) { $related.Add($other) }
        }
        if ($related.Count -eq 0) { continue }

        $content = [System.IO.File]::ReadAllText($fi.FullPath, [System.Text.Encoding]::UTF8)
        $backlinkLines = @('## 관련 노트')
        foreach ($rel in ($related | Sort-Object { $_.Date })) {
            $backlinkLines += "- [[$($rel.Name)]]"
        }
        $backlinkBlock = $backlinkLines -join "`n"

        if ($content -match '## 관련 노트') {
            $content = [regex]::Replace($content, '## 관련 노트\r?\n(- \[\[.+?\]\]\r?\n?)*', '')
            $content = $content.TrimEnd() + "`n`n$backlinkBlock`n"
        } else {
            $content = $content.TrimEnd() + "`n`n$backlinkBlock`n"
        }

        if (-not $DryRun) {
            [System.IO.File]::WriteAllText($fi.FullPath, $content, [System.Text.UTF8Encoding]::new($false))
        }
        $backlinksAdded += $related.Count
    }
}

# ============================================================
# 5. SUMMARY
# ============================================================
Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host '           PROCESSING SUMMARY           ' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host "Total files found:       $totalFiles"
Write-Host "Processed:               $processed"
Write-Host "Skipped:                 $skipped"
Write-Host "Frontmatter added:       $fmAdded"
Write-Host "Frontmatter updated:     $fmUpdated"
Write-Host "Titles fixed:            $titleFixed"
Write-Host "Tags added:              $tagsAdded"
Write-Host "Projects assigned:       $projectSet"
Write-Host "Backlinks added:         $backlinksAdded"
Write-Host ''
Write-Host '--- Project Distribution ---' -ForegroundColor Cyan
foreach ($p in ($projectCounts.GetEnumerator() | Sort-Object Value -Descending)) {
    Write-Host ('  {0,-20} {1}' -f $p.Key, $p.Value)
}
if ($DryRun) {
    Write-Host ''
    Write-Host '[DRY RUN - No files were actually modified]' -ForegroundColor Yellow
}
