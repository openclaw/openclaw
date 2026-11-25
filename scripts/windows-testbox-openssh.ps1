function Get-OpenSshAclDisposition {
  param([Security.AccessControl.RawSecurityDescriptor]$Descriptor, [bool]$Directory)

  $trustedOwners = @('S-1-5-18', 'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  if ($null -eq $Descriptor -or $null -eq $Descriptor.Owner) { return 'unknown' }
  if ($Descriptor.Owner.Value -notin $trustedOwners) { return 'unsafe' }
  if (-not ($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or
      $null -eq $Descriptor.DiscretionaryAcl) { return 'unsafe' }
  $write = [long][Security.AccessControl.FileSystemRights]::Write -bor
    [long][Security.AccessControl.FileSystemRights]::Delete -bor
    [long][Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [long][Security.AccessControl.FileSystemRights]::TakeOwnership
  if ($Directory) { $write = $write -bor [long][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles }
  $known = 0xf0000000L -bor [long][Security.AccessControl.FileSystemRights]::FullControl
  foreach ($ace in $Descriptor.DiscretionaryAcl) {
    # Inherit-only rights apply to future children, not this object. Inspect raw ACEs:
    # GetAccessRules omits unsupported ACEs and leaves signed generic masks unmapped.
    if ($ace.AceFlags -band [Security.AccessControl.AceFlags]::InheritOnly) { continue }
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
        $ace.AceQualifier -notin @([Security.AccessControl.AceQualifier]::AccessAllowed,
          [Security.AccessControl.AceQualifier]::AccessDenied) -or
        ([int]$ace.AceFlags -band 0xe0)) { return 'unknown' }
    $mask = [long]$ace.AccessMask -band 0xffffffffL
    if ($mask -band (-bnot $known)) { return 'unknown' }
    # Denies cannot cancel an unsafe allow here; this screens the installation,
    # not a particular token's effective access. GENERIC_READ/EXECUTE are read-only.
    if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
        $ace.SecurityIdentifier.Value -notin $trustedOwners -and
        ($mask -band (0x50000000L -bor $write))) { return 'unsafe' }
  }
  return 'safe'
}

function Get-WindowsTestboxOpenSshInstallation {
  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version Latest
  try {
    $services = @(Get-CimInstance Win32_Service -Filter "Name='sshd'")
    if ($services.Count -ne 1) { throw 'service' }
    $service = $services[0]
    if ($service.State -ne 'Running' -or $service.StartName -ne 'LocalSystem' -or
        $service.ProcessId -le 0) { throw 'service' }
    $directories = @("$env:WINDIR\System32\OpenSSH", "$env:ProgramFiles\OpenSSH",
      "$env:ProgramFiles\OpenSSH-Win64")
    $selected = @($directories | Where-Object {
      $candidate = "$_\sshd.exe"
      $service.PathName.Trim() -ieq "`"$candidate`"" -or
        ($candidate -notmatch '\s' -and $service.PathName.Trim() -ieq $candidate)
    })
    if ($selected.Count -ne 1 -or $selected[0] -notmatch '^[A-Za-z]:\\') { throw 'path' }
    $directory = $selected[0]
    $sshd = "$directory\sshd.exe"
    $keygen = "$directory\ssh-keygen.exe"
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)"
    if (-not $process -or $process.ExecutablePath -ine $sshd -or -not $process.CreationDate) { throw 'process' }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne 'S-1-5-18') { throw 'owner' }

    # Check each component before following it. OS ancestors and provider DLLs
    # remain image-owned; only the selected directory and executed pair get ACL checks.
    $component = [IO.Path]::GetPathRoot($directory)
    $paths = @($component)
    foreach ($part in $directory.Substring($component.Length).Split('\')) {
      $component = Join-Path $component $part
      $paths += $component
    }
    foreach ($entry in @($paths) + @($sshd, $keygen)) {
      $item = Get-Item -LiteralPath $entry -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          $item.PSIsContainer -ne ($entry -in $paths)) { throw 'filesystem' }
    }
    foreach ($entry in @($directory, $sshd, $keygen)) {
      $acl = Get-Acl -LiteralPath $entry
      $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      if ((Get-OpenSshAclDisposition $descriptor ($entry -eq $directory)) -ne 'safe') { throw 'acl' }
    }
    foreach ($entry in @($sshd, $keygen)) {
      $signature = Get-AuthenticodeSignature -LiteralPath $entry
      if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
          $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cnotin
            @('Microsoft Corporation', 'Microsoft Windows')) { throw 'signature' }
    }

    # Admission belongs to the same running service/process observed before the
    # filesystem checks; a restart or configuration change requires a fresh attempt.
    $currentServices = @(Get-CimInstance Win32_Service -Filter "Name='sshd'")
    if ($currentServices.Count -ne 1) { throw 'service changed' }
    $current = $currentServices[0]
    if ($current.ProcessId -ne $service.ProcessId -or $current.State -ne $service.State -or
        $current.StartName -ne $service.StartName -or $current.PathName -cne $service.PathName) { throw 'service changed' }
    $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($current.ProcessId)"
    if (-not $currentProcess -or $currentProcess.ExecutablePath -ine $sshd -or
        -not $currentProcess.CreationDate -or $currentProcess.CreationDate -ne $process.CreationDate) { throw 'process changed' }
    return [pscustomobject]@{ Sshd = $sshd; Keygen = $keygen }
  } catch {
    throw 'Cannot admit the native Windows OpenSSH installation; verify the provider service, Microsoft binaries, and installation permissions.'
  }
}
