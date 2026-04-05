# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [1.2.0] - 2025-10-27

### SECURITY

- python: added `Decompressor::can_accept_more_data` method and optional
  `output_buffer_limit` argument `Decompressor::process`;
  that allows mitigation of unexpectedly large output;
  reported by Charles Chan (https://github.com/charleswhchan)

### Added

- **decoder / encoder: added static initialization to reduce binary size**
- python: allow limiting decoder output (see SECURITY section)
- CLI: `brcat` alias; allow decoding concatenated brotli streams
- kt: pure Kotlin decoder
- cgo: support "raw" dictionaries
- build: Bazel modules

### Removed

- java: dropped `finalize()` for native entities

### Fixed

- java: in `compress` pass correct length to native encoder

### Improved

- build: install man pages
- build: updated / fixed / refined Bazel buildfiles
- encoder: faster encoding
- cgo: link via pkg-config
- python: modernize extension / allow multi-phase module initialization

### Changed

- decoder / encoder: static tables use "small" model (allows 2GiB+ binaries)

## [1.1.0] - 2023-08-28

### Added

- decoder: `BrotliDecoderAttachDictionary`
- decoder: `BrotliDecoderOnFinish` callback behind `BROTLI_REPORTING`
- decoder: `BrotliDecoderSetMetadataCallbacks`
- encoder: `BrotliEncoderPrepareDictionary`,
  `BrotliEncoderDestroyPreparedDictionary`,
  `BrotliEncoderAttachPreparedDictionary`
- decoder: `BrotliEncoderOnFinish` callback behind `BROTLI_REPORTING`
- common: `BrotliSharedDictionaryCreateInstance`,
  `BrotliSharedDictionaryDestroyInstance`,
  `BrotliSharedDictionaryAttach`
- CLI: `--dictionary` option
- java: encoder wrapper: `Parameters.mode`
- java: `Brotli{Input|Output}Stream.attachDictionary`
- java: wrapper: partial byte array input
- typescript: decoder (transpiled from Java)

### Removed

- build: `BROTLI_BUILD_PORTABLE` option

### Fixed

- java: JNI decoder failed sometimes on power of 2 payloads

### Improved

- java / js: smaller decoder footprint
- decoder: faster decoding
- encoder: faster encoding
- encoder: smaller stack frames

## [1.0.9] - 2020-08-27

Re-release of 1.0.8.

## [1.0.8] - 2020-08-27

### SECURITY

- CVE-2020-8927: potential overflow when input chunk is >2GiB

### Added

- encoder: `BROTLI_PARAM_STREAM_OFFSET`

### Improved

- CLI: better reporting
- CLI: workaround for "lying feof"
- java: faster decoding
- java: support "large window"
- encoder: use less memory
- release: filter sources for the tarball

## [1.0.7] - 2018-10-23

### Improved

- decoder: faster decoding on ARM CPU

## [1.0.6] - 2018-09-13

### Fixed

- build: AutoMake and CMake build
- java: JDK 8<->9 incompatibility

## [1.0.5] - 2018-06-27

### Added

- scripts: extraction of static dictionary from RFC

### Improved

- encoder: better compression at quality 1
- encoder: better compression with "large window"

## [1.0.4] - 2018-03-29

### Added

- encoder: `BROTLI_PARAM_NPOSTFIX`, `BROTLI_PARAM_NDIRECT`
- CLI: `--large_window` option

### Improved

- encoder: better compression

## [1.0.3] - 2018-03-02

### Added

- decoder: `BROTLI_DECODER_PARAM_LARGE_WINDOW` enum
- encoder: `BROTLI_PARAM_LARGE_WINDOW` enum
- java: `BrotliInputStream.setEager`

### Fixed

- build: AutoMake build in some environments
- encoder: fix one-shot q=10 1-byte input compression

### Improved

- encoder: better font compression

## [1.0.2] - 2017-11-28

### Added

- build: AutoMake
- research: better dictionary generators

## [1.0.1] - 2017-09-22

### Changed

- clarifications in `README.md`

## [1.0.0] - 2017-09-20

### Added

- decoder: `BrotliDecoderSetParameter`
- csharp: decoder (transpiled from Java)
- java: JNI wrappers
- javascript: decoder (transpiled from Java)
- python: streaming decompression
- research: dictionary generator

### Changed

- CLI: rename `bro` to `brotli`

### Removed

- decoder: `BrotliDecoderSetCustomDictionary`
- encoder: `BrotliEncoderSetCustomDictionary`

### Improved

- java: faster decoding
- encoder: faster compression

## [0.6.0] - 2017-04-10

### Added

- CLI: `--no-copy-stat option
- java: pure java decoder
- build: fuzzers
- research: `brotlidump` tool to explore brotli streams
- go: wrapper

### Removed

- decoder: API with plain `Brotli` prefix

### Deprecated

- encoder: `BrotliEncoderInputBlockSize`, `BrotliEncoderCopyInputToRingBuffer`,
  `BrotliEncoderWriteData`

### Improved

- encoder: faster compression
- encoder: denser compression
- decoder: faster decompression
- python: release GIL
- python: use zero-copy API

## [0.5.2] - 2016-08-11

### Added

- common: `BROTLI_BOOL`, `BROTLI_TRUE`, `BROTLI_FALSE`
- decoder: API with `BrotliDecoder` prefix instead of plain `Brotli`
- build: Bazel, CMake

### Deprecated

- decoder: API with plain `Brotli` prefix

### Changed

- boolean argument / result types are re-branded as `BROTLI_BOOL`

### Improved

- build: reduced amount of warnings in various build environments
- encoder: faster compression
- encoder: lower memory usage

## [0.5.0] - 2016-06-15

### Added

- common: library has been assembled from shared parts of decoder and encoder
- encoder: C API

### Removed

- encoder: C++ API

## [0.4.0] - 2016-06-14

### Added

- encoder: faster compression modes (quality 0 and 1)
- decoder: `BrotliGetErrorCode`, `BrotliErrorString` and
  `BROTLI_ERROR_CODES_LIST`

### Removed

- decoder: deprecated streaming API (using `BrotliInput`)

### Fixed

- decoder: possible pointer underflow

### Improved

- encoder: faster compression

## [0.3.0] - 2015-12-22

### LICENSE

License have been upgraded to more permissive MIT.

### Added

- CLI: `--window` option
- `tools/version.h` file
- decoder: low level streaming API
- decoder: custom memory manager API

### Deprecated

- decoder: streaming API using `BrotliInput` struct

### Fixed

- decoder: processing of uncompressed blocks
- encoder: possible division by zero

### Improved

- encoder: faster decompression
- build: more portable builds for various CPU architectures

## [0.2.0] - 2015-09-01

### Added

- CLI: `--verbose` and `--repeat` options

### Fixed

- decoder: processing of uncompressed blocks
- encoder: block stitching on quality 10 / 11

### Improved

- build: CI/CD integration
- build: better test coverage
- encoder: better compression of UTF-8 content
- encoder: faster decompression

## [0.1.0] - 2015-08-11

Initial release.
