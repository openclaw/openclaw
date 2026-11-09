The two Swift helpers are copied without changes from
[`jo-duchan/tapflow`](https://github.com/jo-duchan/tapflow), commit
`1b9f2970b23f4c3b22182c56356a30633e693568`,
`packages/ios-agent/src/{touch-helper,screencapture-helper}.swift`.

SHA-256:

- `touch-helper.swift`: `a77d6fa319b955bf0315399cf8b5e9cd0fd8db6df3caeb0d29d8cdeefbdc6a3c`
- `screencapture-helper.swift`: `4267bdfaeebc433d074b6043db4be06b0f6f6cd978ddd957c0bb589b10833d7c`

The helpers use SimulatorKit from the selected Xcode. The app launches both
against one exact booted iOS device ID and ends them with the owning desktop
execution. MIT and Apache 2.0 attribution is in this directory and the app bundle.
