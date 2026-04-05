<p align="center">
  <img src="https://github.com/google/brotli/actions/workflows/build_test.yml/badge.svg" alt="GitHub Actions Build Status" href="https://github.com/google/brotli/actions?query=branch%3Amaster">
  <img src="https://oss-fuzz-build-logs.storage.googleapis.com/badges/brotli.svg" alt="Fuzzing Status" href="https://oss-fuzz-build-logs.storage.googleapis.com/index.html#brotli">
</p>
<p align="center"><img src="https://brotli.org/brotli.svg" alt="Brotli" width="64"></p>

### Introduction

Brotli is a generic-purpose lossless compression algorithm that compresses data
using a combination of a modern variant of the LZ77 algorithm, Huffman coding
and 2nd order context modeling, with a compression ratio comparable to the best
currently available general-purpose compression methods. It is similar in speed
with deflate but offers more dense compression.

The specification of the Brotli Compressed Data Format is defined in
[RFC 7932](https://datatracker.ietf.org/doc/html/rfc7932).

Brotli is open-sourced under the MIT License, see the LICENSE file.

> **Please note:** brotli is a "stream" format; it does not contain
> meta-information, like checksums or uncompressed data length. It is possible
> to modify "raw" ranges of the compressed stream and the decoder will not
> notice that.

### Installation

In most Linux distributions, installing `brotli` is just a matter of using
the package management system. For example in Debian-based distributions:
`apt install brotli` will install `brotli`. On MacOS, you can use
[Homebrew](https://brew.sh/): `brew install brotli`.

[![brotli packaging status](https://repology.org/badge/vertical-allrepos/brotli.svg?exclude_unsupported=1&columns=3&exclude_sources=modules,site&header=brotli%20packaging%20status)](https://repology.org/project/brotli/versions)

Of course you can also build brotli from sources.

### Build instructions

#### Vcpkg

You can download and install brotli using the
[vcpkg](https://github.com/Microsoft/vcpkg/) dependency manager:

    git clone https://github.com/Microsoft/vcpkg.git
    cd vcpkg
    ./bootstrap-vcpkg.sh
    ./vcpkg integrate install
    ./vcpkg install brotli

The brotli port in vcpkg is kept up to date by Microsoft team members and
community contributors. If the version is out of date, please [create an issue
or pull request](https://github.com/Microsoft/vcpkg) on the vcpkg repository.

#### Bazel

See [Bazel](https://www.bazel.build/)

#### CMake

The basic commands to build and install brotli are:

    $ mkdir out && cd out
    $ cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=./installed ..
    $ cmake --build . --config Release --target install

You can use other [CMake](https://cmake.org/) configuration.

#### Python

To install the latest release of the Python module, run the following:

    $ pip install brotli

To install the tip-of-the-tree version, run:

    $ pip install --upgrade git+https://github.com/google/brotli

See the [Python readme](python/README.md) for more details on installing
from source, development, and testing.

### Contributing

We glad to answer/library related questions in
[brotli mailing list](https://groups.google.com/g/brotli).

Regular issues / feature requests should be reported in
[issue tracker](https://github.com/google/brotli/issues).

For reporting vulnerability please read [SECURITY](SECURITY.md).

For contributing changes please read [CONTRIBUTING](CONTRIBUTING.md).

### Benchmarks

- [Squash Compression Benchmark](https://quixdb.github.io/squash-benchmark/) / [Unstable Squash Compression Benchmark](https://quixdb.github.io/squash-benchmark/unstable/)
- [Large Text Compression Benchmark](https://mattmahoney.net/dc/text.html)
- [Lzturbo Benchmark](https://sites.google.com/site/powturbo/home/benchmark)

### Related projects

> **Disclaimer:** Brotli authors take no responsibility for the third party projects mentioned in this section.

Independent [decoder](https://github.com/madler/brotli) implementation
by Mark Adler, based entirely on format specification.

JavaScript port of brotli [decoder](https://github.com/devongovett/brotli.js).
Could be used directly via `npm install brotli`

Hand ported [decoder / encoder](https://github.com/dominikhlbg/BrotliHaxe)
in haxe by Dominik Homberger.
Output source code: JavaScript, PHP, Python, Java and C#

7Zip [plugin](https://github.com/mcmilk/7-Zip-Zstd)

Dart compression framework with
[fast FFI-based Brotli implementation](https://pub.dev/documentation/es_compression/latest/brotli/)
with ready-to-use prebuilt binaries for Win/Linux/Mac
