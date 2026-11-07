# Selected Material icons

These 97 vector implementations are copied from AndroidX Compose Material Icons
Extended 1.7.8. The third-party flavor contains its own copy of `ScreenShare`.
The app keeps Material Icons Core for its common icons and vector builder helpers.
This avoids processing the complete Extended library during builds.

Source archive: [Google Maven](https://dl.google.com/dl/android/maven2/androidx/compose/material/material-icons-extended-android/1.7.8/material-icons-extended-android-1.7.8-sources.jar)

SHA-256: `77b7e782a519a3e074fc91e09d59334ac1b815edd87d2e89c0c9ca7c95678e93`

Each file comes from `commonMain/androidx/compose/material/icons/` in that archive.
Packages are relocated, private vector caches are renamed to satisfy repository
style, and repository formatting is applied. The paths, vector names, mirroring,
and lazy initialization are unchanged. Preserve the Apache 2.0 headers and
the AndroidX Compose entry in `THIRD_PARTY_LICENSES` when updating these files.
Copy additional icons here as needed instead of adding the full Extended library.
