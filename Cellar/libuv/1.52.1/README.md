![libuv][libuv_banner]

## Overview

libuv is a multi-platform support library with a focus on asynchronous I/O. It
was primarily developed for use by [Node.js][], but it's also
used by [Luvit](http://luvit.io/), [Julia](http://julialang.org/),
[uvloop](https://github.com/MagicStack/uvloop), and [others](https://github.com/libuv/libuv/blob/v1.x/LINKS.md).

## Feature highlights

- Full-featured event loop backed by epoll, kqueue, IOCP, event ports.

- Asynchronous TCP and UDP sockets

- Asynchronous DNS resolution

- Asynchronous file and file system operations

- File system events

- ANSI escape code controlled TTY

- IPC with socket sharing, using Unix domain sockets or named pipes (Windows)

- Child processes

- Thread pool

- Signal handling

- High resolution clock

- Threading and synchronization primitives

## Versioning

Starting with version 1.0.0 libuv follows the [semantic versioning](http://semver.org/)
scheme. The API change and backwards compatibility rules are those indicated by
SemVer. libuv will keep a stable ABI across major releases.

The ABI/API changes can be tracked [here](http://abi-laboratory.pro/tracker/timeline/libuv/).

## Licensing

libuv is licensed under the MIT license. Check the [LICENSE](LICENSE) and
[LICENSE-extra](LICENSE-extra) files.

The documentation is licensed under the CC BY 4.0 license. Check the
[LICENSE-docs file](LICENSE-docs).

## Community

- [Support](https://github.com/libuv/libuv/discussions)
- [Mailing list](http://groups.google.com/group/libuv)

## Documentation

### Official documentation

Located in the docs/ subdirectory. It uses the [Sphinx](http://sphinx-doc.org/)
framework, which makes it possible to build the documentation in multiple
formats.

Show different supported building options:

```bash
$ make help
```

Build documentation as HTML:

```bash
$ make html
```

Build documentation as HTML and live reload it when it changes (this requires
sphinx-autobuild to be installed and is only supported on Unix):

```bash
$ make livehtml
```

Build documentation as man pages:

```bash
$ make man
```

Build documentation as ePub:

```bash
$ make epub
```

NOTE: Windows users need to use make.bat instead of plain 'make'.

Documentation can be browsed online [here](http://docs.libuv.org).

The [tests and benchmarks](https://github.com/libuv/libuv/tree/master/test)
also serve as API specification and usage examples.

### Other resources

- [LXJS 2012 talk](http://www.youtube.com/watch?v=nGn60vDSxQ4)
  &mdash; High-level introductory talk about libuv.
- [libuv-dox](https://github.com/thlorenz/libuv-dox)
  &mdash; Documenting types and methods of libuv, mostly by reading uv.h.
- [learnuv](https://github.com/thlorenz/learnuv)
  &mdash; Learn uv for fun and profit, a self guided workshop to libuv.

These resources are not handled by libuv maintainers and might be out of
date. Please verify it before opening new issues.

## Downloading

libuv can be downloaded either from the
[GitHub repository](https://github.com/libuv/libuv)
or from the [downloads site](http://dist.libuv.org/dist/).

Before verifying the git tags or signature files, importing the relevant keys
is necessary. Key IDs are listed in the
[MAINTAINERS](https://github.com/libuv/libuv/blob/master/MAINTAINERS.md)
file, but are also available as git blob objects for easier use.

Importing a key the usual way:

```bash
$ gpg --keyserver pool.sks-keyservers.net --recv-keys AE9BC059
```

Importing a key from a git blob object:

```bash
$ git show pubkey-saghul | gpg --import
```

### Verifying releases

Git tags are signed with the developer's key, they can be verified as follows:

```bash
$ git verify-tag v1.6.1
```

Starting with libuv 1.7.0, the tarballs stored in the
[downloads site](http://dist.libuv.org/dist/) are signed and an accompanying
signature file sit alongside each. Once both the release tarball and the
signature file are downloaded, the file can be verified as follows:

```bash
$ gpg --verify libuv-1.7.0.tar.gz.sign
```

## Build Instructions

For UNIX-like platforms, including macOS, there are two build methods:
autotools or [CMake][].

For Windows, [CMake][] is the only supported build method and has the
following prerequisites:

<details>

- One of:
  - [Visual C++ Build Tools][]
  - [Visual Studio 2015 Update 3][], all editions
    including the Community edition (remember to select
    "Common Tools for Visual C++ 2015" feature during installation).
  - [Visual Studio 2017][], any edition (including the Build Tools SKU).
    **Required Components:** "MSbuild", "VC++ 2017 v141 toolset" and one of the
    Windows SDKs (10 or 8.1).
- Basic Unix tools required for some tests,
  [Git for Windows][] includes Git Bash
  and tools which can be included in the global `PATH`.

</details>

To build with autotools:

```bash
$ sh autogen.sh
$ ./configure
$ make
$ make check
$ make install
```

To build with [CMake][]:

```bash
$ cmake -B build -DBUILD_TESTING=ON         # generate project with tests
$ cmake --build build                       # add `-j <n>` with cmake >= 3.12

# Run tests:
$ (cd build && ctest -C Debug --output-on-failure)

# Or manually run tests:
$ build/uv_run_tests                        # shared library build
$ build/uv_run_tests_a                      # static library build
```

To cross-compile with [CMake][] (unsupported but generally works):

```bash
$ cmake ../..                 \
  -DCMAKE_SYSTEM_NAME=Windows \
  -DCMAKE_SYSTEM_VERSION=6.1  \
  -DCMAKE_C_COMPILER=i686-w64-mingw32-gcc
```

### Install with Homebrew

```bash
$ brew install --HEAD libuv
```

Note to macOS users:

Make sure that you specify the architecture you wish to build for in the
"ARCHS" flag. You can specify more than one by delimiting with a space
(e.g. "x86_64 i386").

### Install with vcpkg

```bash
$ git clone https://github.com/microsoft/vcpkg.git
$ ./bootstrap-vcpkg.bat # for powershell
$ ./bootstrap-vcpkg.sh # for bash
$ ./vcpkg install libuv
```

### Install with Conan

You can install pre-built binaries for libuv or build it from source using [Conan](https://conan.io/). Use the following command:

```bash
conan install --requires="libuv/[*]" --build=missing
```

The libuv Conan recipe is kept up to date by Conan maintainers and community contributors.
If the version is out of date, please [create an issue or pull request](https://github.com/conan-io/conan-center-index) on the ConanCenterIndex repository.

### Running tests

Some tests are timing sensitive. Relaxing test timeouts may be necessary
on slow or overloaded machines:

```bash
$ env UV_TEST_TIMEOUT_MULTIPLIER=2 build/uv_run_tests # 10s instead of 5s
```

#### Run one test

The list of all tests is in `test/test-list.h`.

This invocation will cause the test driver to fork and execute `TEST_NAME` in
a child process:

```bash
$ build/uv_run_tests_a TEST_NAME
```

This invocation will cause the test driver to execute the test in
the same process:

```bash
$ build/uv_run_tests_a TEST_NAME TEST_NAME
```

#### Debugging tools

When running the test from within the test driver process
(`build/uv_run_tests_a TEST_NAME TEST_NAME`), tools like gdb and valgrind
work normally.

When running the test from a child of the test driver process
(`build/uv_run_tests_a TEST_NAME`), use these tools in a fork-aware manner.

##### Fork-aware gdb

Use the [follow-fork-mode](https://sourceware.org/gdb/onlinedocs/gdb/Forks.html) setting:

```
$ gdb --args build/uv_run_tests_a TEST_NAME

(gdb) set follow-fork-mode child
...
```

##### Fork-aware valgrind

Use the `--trace-children=yes` parameter:

```bash
$ valgrind --trace-children=yes -v --tool=memcheck --leak-check=full --track-origins=yes --leak-resolution=high --show-reachable=yes --log-file=memcheck-%p.log build/uv_run_tests_a TEST_NAME
```

### Running benchmarks

See the section on running tests.
The benchmark driver is `./uv_run_benchmarks_a` and the benchmarks are
listed in `test/benchmark-list.h`.

## Supported Platforms

Check the [SUPPORTED_PLATFORMS file](SUPPORTED_PLATFORMS.md).

### `-fno-strict-aliasing`

It is recommended to turn on the `-fno-strict-aliasing` compiler flag in
projects that use libuv. The use of ad hoc "inheritance" in the libuv API
may not be safe in the presence of compiler optimizations that depend on
strict aliasing.

MSVC does not have an equivalent flag but it also does not appear to need it
at the time of writing (December 2019.)

### AIX Notes

AIX compilation using IBM XL C/C++ requires version 12.1 or greater.

AIX support for filesystem events requires the non-default IBM `bos.ahafs`
package to be installed. This package provides the AIX Event Infrastructure
that is detected by `autoconf`.
[IBM documentation](http://www.ibm.com/developerworks/aix/library/au-aix_event_infrastructure/)
describes the package in more detail.

### z/OS Notes

z/OS compilation requires [ZOSLIB](https://github.com/ibmruntimes/zoslib) to be installed. When building with [CMake][], use the flag `-DZOSLIB_DIR` to specify the path to [ZOSLIB](https://github.com/ibmruntimes/zoslib):

```bash
$ (cd build && cmake .. -DBUILD_TESTING=ON -DZOSLIB_DIR=/path/to/zoslib)
$ cmake --build build
```

z/OS creates System V semaphores and message queues. These persist on the system
after the process terminates unless the event loop is closed.

Use the `ipcrm` command to manually clear up System V resources.

## Patches

See the [guidelines for contributing][].

[CMake]: https://cmake.org/
[node.js]: http://nodejs.org/
[guidelines for contributing]: https://github.com/libuv/libuv/blob/master/CONTRIBUTING.md
[libuv_banner]: https://raw.githubusercontent.com/libuv/libuv/master/img/banner.png
[Visual C++ Build Tools]: https://visualstudio.microsoft.com/visual-cpp-build-tools/
[Visual Studio 2015 Update 3]: https://www.visualstudio.com/vs/older-downloads/
[Visual Studio 2017]: https://www.visualstudio.com/downloads/
[Git for Windows]: http://git-scm.com/download/win
