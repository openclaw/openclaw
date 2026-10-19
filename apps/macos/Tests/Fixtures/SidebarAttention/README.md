# Native sidebar attention proof

This opt-in fixture hosts the production shared chat shell with synthetic
sessions and a memory-only transport. It never connects to a Gateway. It uses a
unique defaults suite for disclosure and model preferences. Question lists,
readback, and resolution events share one in-memory record owner; resolved
questions stay terminal after refresh. Approval snapshots
exercise presentation only; `ExecApprovalQueueStoreTests` covers the Mac queue's
Gateway events, canonical previews, expiry, and allowed decisions.

Build after the repository's native resources have been generated:

```sh
swift build --package-path apps/macos/Tests/Fixtures/SidebarAttention \
  --scratch-path /tmp/openclaw-sidebar-attention-fixture
```

For before screenshots, copy this fixture directory into the baseline checkout
and add `-Xswiftc -DATTENTION_BASELINE`. The baseline uses the same session and
question transport without referencing new attention types.

The proof owner must package the executable with its SwiftPM resource bundles,
sign with the matching Developer ID, and launch only in the approved isolated
macOS environment. This fixture does not grant launch or upload authority.

Capture the initial collapsed Projects heading and both agent rows, expand
Projects, and inspect Website refresh and Preview deployment. Click question and
approval badges, verify the oldest preview and additional count, and ensure the
selected Today conversation does not change. The toolbar can resolve the oldest
question and clear approvals to verify badge updates. Use the Research agent to
inspect its separate system approval preview. Repeat in light/dark appearances
and inspect VoiceOver labels and keyboard focus.
