---
summary: "Portable archive-delta research control, measured transfer sizes, and proof limitations"
title: "Update archive-delta benchmark"
read_when:
  - Measuring bandwidth savings for application updates
  - Comparing archive deltas with native update delivery
---

# Update archive-delta benchmark

This is a research control, not an updater. It uses an externally installed
Zstandard CLI to reconstruct an exact target archive from a previous archive and
a patch. It does not introduce a runtime dependency, change update defaults,
sign artifacts, or install applications.

The macOS app already uses Sparkle. A Zstandard archive patch is **not** a Sparkle
patch and must not be placed in an appcast. Native Sparkle generation, signature
verification, full-download fallback, installation, and recovery require separate
proof through the actual macOS updater.

## Run the control

Use public, same-platform, same-architecture release artifacts. Verify their
provenance and expected digests before benchmarking. The command does not download
artifacts or verify release signatures.

    node scripts/bench-update-delta.mjs BASE.zip TARGET.zip NEW_OUTPUT_DIRECTORY

Both inputs must be nonempty regular files no larger than 512 MiB. The output
directory must not exist; its parent must exist. The command never overwrites a
previous run. It writes a patch and reconstructed archive, then writes a JSON
report only after the reconstructed archive's SHA-256 matches the target. A failed
run can leave diagnostic artifacts but does not write a successful report.

The control uses one compression thread and an explicit 512 MiB decode-window
limit. Input and window bounds are not a peak-memory guarantee: the dictionary,
window, and process overhead also consume memory. A slow link may benefit from
fewer transfer bytes while a memory-constrained device may not support this
approach at all.

## Observed arm64 release pair

One local Linux run used Zstandard 1.5.7 with warm filesystem caches. These are
observed results from the exploratory run, not a performance guarantee or a
measurement produced by the unit-test codec fixture.

| Measurement                                           |                     Result |
| ----------------------------------------------------- | -------------------------: |
| Base: OpenClaw 2026.10.10 arm64 ZIP                   |          463,230,770 bytes |
| Target: OpenClaw 2026.11.1 arm64 ZIP                  |          463,392,318 bytes |
| Archive patch                                         |          125,815,187 bytes |
| Bytes avoided                                         | 337,577,131 bytes (72.85%) |
| Generation wall time                                  |                     876 ms |
| Application wall time                                 |                     346 ms |
| Whole-command peak RSS, external GNU time measurement |                947,096 KiB |

Source artifacts:

- [OpenClaw 2026.10.10 arm64 ZIP](https://github.com/openclaw/openclaw/releases/download/v2026.10.10/OpenClaw-2026.10.10-arm64.zip)
- [OpenClaw 2026.11.1 arm64 ZIP](https://github.com/openclaw/openclaw/releases/download/v2026.11.1/OpenClaw-2026.11.1-arm64.zip)

SHA-256 values from the run:

| Artifact                  | SHA-256                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| Base                      | 87bd0fd5db26e439c03fdfcdde45f7bc3a71ce995f6b0036bbf2eedf7c63025e |
| Target and reconstruction | 95b3070963dda23239eefcaab359cf2c1cda8d32fc9ddeb7b4efaad3548e72eb |
| Patch                     | 78ef0549656a3e37034573b16cf2e312d133e1dba5e7cf8dbe4746faabed75d1 |

The input sizes and SHA-256 values matched the GitHub release-asset metadata.
That checks artifact consistency, not an independent signing identity. Matching
reconstruction proves exact target bytes, not safe installation or launch.

## Report and proof limits

The JSON report records codec version, options, input and output byte counts,
SHA-256 values, generation and application wall times, and the transfer fraction.
It deliberately reports signatureVerified as false and peakMemoryBytes as null:
the script does not verify signatures or measure memory. The RSS value above was
measured separately using GNU time's verbose mode around the whole command.

The focused tests exercise the real script entry point with a fixed external
codec fixture. They check report contents, corrupt reconstruction rejection,
argument errors, and preservation of previous results. They do not prove Zstandard
compression behavior; the real-artifact run is separate evidence for that.

Before making native-updater claims, measure native patches on representative
release pairs and verify the real updater's valid-delta, missing/wrong-base,
corrupt-delta, bad-signature, full-download fallback, interruption, installation,
and recovery paths. Include skipped releases and architecture/channel boundaries.
Do not infer a post-launch health rollback guarantee from installation-failure
recovery alone.
