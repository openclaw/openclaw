The two Swift helpers derive from
[`jo-duchan/tapflow`](https://github.com/jo-duchan/tapflow), commit
`1b9f2970b23f4c3b22182c56356a30633e693568`,
`packages/ios-agent/src/{touch-helper,screencapture-helper}.swift`.

SHA-256:

- `touch-helper.swift`: `3fcdaecfbf38bc8ba26097cddc37d82359bb8a590739bff5c635b176514d9d15`
- `screencapture-helper.swift`: `4267bdfaeebc433d074b6043db4be06b0f6f6cd978ddd957c0bb589b10833d7c`

`screencapture-helper.swift` is byte-for-byte upstream. `touch-helper.swift`
adds owner cleanup on stdin EOF and one-byte acknowledgments after touch cancel;
these let the Mac app wait for a held touch to release before ending the helper.

The helpers use SimulatorKit from the selected Xcode. The app launches both
against one exact booted iOS device ID and ends them with the owning desktop
execution. MIT and Apache 2.0 attribution is in this directory and the app bundle.
