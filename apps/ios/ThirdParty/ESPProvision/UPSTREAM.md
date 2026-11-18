# ESPProvision source

Vendored from Espressif esp-idf-provisioning-ios at commit
`78e58f010f8539f800bce063a26d3e4c4ac596b9`:
https://github.com/espressif/esp-idf-provisioning-ios/tree/78e58f010f8539f800bce063a26d3e4c4ac596b9

The package sources and original Apache-2.0 LICENSE are retained. Examples and
project files are omitted. OpenClaw requires Security2 with the counter-IV
patch advertised before any handshake; ESPDevice.initialiseSession rejects
other or malformed advertisements instead of falling back to Security1.
Cryptography stays with the vendor implementation.

The local package adds an SDK-boundary test target for advertisement rejection.
Bundled BigInt and SRP sources retain their original MIT notices; those notices,
Espressif's Apache license and SwiftProtobuf's license also appear in Settings.

The local package pins SwiftProtobuf 1.39.0 so application resolution cannot
silently select another runtime.
