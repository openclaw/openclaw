# WinGet contract qualification (source evidence, not native acceptance)

## Arg is correct; no product parser repair

Personally read the exact official serializer and dispatch from microsoft/winget-cli v1.29.380, commit 000f6b55151cb0f1afd2933bb54c62a4724b9ca8:

- [SourceExportCommand::ExecuteInternal](https://github.com/microsoft/winget-cli/blob/000f6b55151cb0f1afd2933bb54c62a4724b9ca8/src/AppInstallerCLICore/Commands/SourceCommand.cpp#L328-L332) dispatches filtered source listing to ExportSourceList.
- [ExportSourceList](https://github.com/microsoft/winget-cli/blob/000f6b55151cb0f1afd2933bb54c62a4724b9ca8/src/AppInstallerCLICore/Workflows/SourceFlow.cpp#L390-L418) copies Name/Type/Arg/Data/Identifier/Explicit/trust to SourceFromPolicy and prints its JSON.
- [SourceFromPolicy::ToJsonString](https://github.com/microsoft/winget-cli/blob/000f6b55151cb0f1afd2933bb54c62a4724b9ca8/src/AppInstallerSharedLib/GroupPolicy.cpp#L361-L385) explicitly emits json["Arg"] = Arg. It does NOT emit Argument.
- [Official default source](https://github.com/microsoft/winget-cli/blob/000f6b55151cb0f1afd2933bb54c62a4724b9ca8/src/AppInstallerRepositoryCore/SourceList.cpp#L39-L42), instantiated at lines345–354, establishes winget, https://cdn.winget.microsoft.com/cache, and Microsoft.Winget.Source_8wekyb3d8bbwe. The [source factory type](https://github.com/microsoft/winget-cli/blob/000f6b55151cb0f1afd2933bb54c62a4724b9ca8/src/AppInstallerRepositoryCore/Microsoft/PreIndexedPackageSourceFactory.h#L23-L28) is Microsoft.PreIndexed.Package.

The immutable product's four-field comparison matches this source contract. Preserve GetProperty("Arg"). A guessed Argument fallback or output-rewriting proof shim would be wrong. Runtime probe records all actual field names but requires only those four authoritative fields, not ordering or a whole-object equality; Data, Explicit, TrustLevel and optional Priority are valid additional fields.

The independent bounded audit also inspected the same serializer at v1.12.350 (95add984d147223256630f762824f768d98d9485), v1.11.430 (43956df571e025cc8739191d3ed2c881b6eac270), and v1.10.390 (a14cbc2ca1265d7b384b749104eb92435ea75e34): all use Arg. This supports compatibility but is not an executed arbitrary-version guarantee.

## windows-2025 prerequisite is an observation gate

The audited actions/runner-images snapshot 4da2307112a0fad2fd2ecaca8ba7d08683b8c581 (2026-10-30) has [Windows2025 inventory](https://github.com/actions/runner-images/blob/4da2307112a0fad2fd2ecaca8ba7d08683b8c581/images/windows/Windows2025-Readme.md), [complete build recipe](https://github.com/actions/runner-images/blob/4da2307112a0fad2fd2ecaca8ba7d08683b8c581/images/windows/templates/build.windows-2025.pkr.hcl), and [toolset](https://github.com/actions/runner-images/blob/4da2307112a0fad2fd2ecaca8ba7d08683b8c581/images/windows/toolsets/toolset-2025.json). It describes Server2025 image20261021.299.1, OS10.0.26100 Build33650 and SDK26100. WinGet/App Installer is not advertised and no dedicated installation step was found in the audited inputs. This is NOT proof it is absent, unprovisioned or unregistered.

The packet therefore inspects actual current-user Microsoft.DesktopAppInstaller registration/Status/Publisher, product alias path, executable signature/version and raw source export. It does not infer availability from image label, PATH or inventory omission. It never bootstraps merely because one lookup failed. .NET10.0.403 remains explicitly supplied by the qualified setup-dotnet action because the inventory lists only10.0.402.

## Supported first-party prerequisite candidate (not admitted or executed here)

A missing-current-user WinGet gate is separate from Ollama absence. An already provisioned family can be registered for the current user by the documented Add-AppxPackage -RegisterByFamilyName -MainPackage contract. Full signed package acquisition uses Add-AppxPackage -Path with explicitly supplied dependency packages, not source/policy reset or Repair-WinGet catch-all.

Pinned [Server2025 Add-AppxPackage documentation](https://github.com/MicrosoftDocs/windows-powershell-docs/blob/0ef3f225d29e26d1cf3119f37dfff70bb6165746/docset/winserver2025-ps/Appx/Add-AppxPackage.md): lines80–87 define signed current-user package deployment; lines230–235 define DependencyPath and preserving installed dependencies; lines394–403 and479–489 define family/full-name registration.

The source audit read only official release text/JSON, never downloaded or executed these package binaries:

- [v1.29.380 App Installer published SHA text](https://github.com/microsoft/winget-cli/releases/download/v1.29.380/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.txt): bundle SHA256 65DEA9C01CE08EE7B763366B27C0E651F97DB857C11CA9B9C301826C10092F2E. Text-file SHA e2a86a4832d96527f11e49c8764adcbca5325a356cfe948296799466df969cdd.
- [Dependency archive published SHA text](https://github.com/microsoft/winget-cli/releases/download/v1.29.380/DesktopAppInstaller_Dependencies.txt): archive SHA256 BA875AFE9D190F61218985AC0292A99D1DB710BF93E13C68944CA9D89F0D82D1. Text-file SHA88e05297d8dcd3cf99407d251e9be7f1e061e56aaae46a08528f057991d5217d.
- [Exact dependency metadata](https://github.com/microsoft/winget-cli/releases/download/v1.29.380/DesktopAppInstaller_Dependencies.json), SHAa56ddd79cf9cd056d9546cfeb6958c2b44d20f6221f8518bf17b003717d47a7a: Microsoft.VCLibs.140.00 >=14.0.33519.0, Microsoft.VCLibs.140.00.UWPDesktop >=14.0.33728.0, Microsoft.WindowsAppRuntime.1.8 >=8000.616.304.0.

A native prerequisite consumer must still qualify downloaded bundle/dependency identities, architecture, Microsoft publisher, current trust, existing versions/current-user registration and normal deployment outcomes before first use. No unsigned/force/downgrade/all-users/source-policy/certificate bypass, no broad state repair, and no assumption that Get-AuthenticodeSignature handles every package format. This packet does NOT install this prerequisite; missing registration is a precise blocked native gate, not proof of an Ollama product defect.

## Remaining native unknowns

Actual runner WinGet version/export, source/catalog resolution, downloaded Ollama released signatures, file-sharing/held-file execution compatibility, Inno app startup/lifetime and actual client shutdown must be observed on the accepted owned Windows runner. Source contracts alone cannot supply these receipts. No actual WinGet command, bundle download, package registration, app install or launch has run in this preparation.
