[![][license img]][license] [![][licensemit img]][licensemit]

[![Doxygen Documentation](https://img.shields.io/badge/docs-doxygen-green.svg)](https://simdjson.github.io/simdjson/)

# simdjson : Parsing gigabytes of JSON per second

<img src="images/official_logo/logo_noir/SVG/logo_simdjson_noir.svg" width="40%" style="float: right">

JSON is everywhere on the Internet. Servers spend a _lot_ of time parsing it. We need a fresh
approach. The simdjson library uses commonly available SIMD instructions and microparallel algorithms
to parse JSON 4x faster than RapidJSON and 25x faster than JSON for Modern C++.

- **Fast:** Over 4x faster than commonly used production-grade JSON parsers.
- **Record Breaking Features:** Minify JSON at 6 GB/s, validate UTF-8 at 13 GB/s, NDJSON at 3.5 GB/s.
- **Easy:** First-class, easy to use and carefully documented APIs.
- **Strict:** Full JSON and UTF-8 validation, lossless parsing. Performance with no compromises.
- **Automatic:** Selects a CPU-tailored parser at runtime. No configuration needed.
- **Reliable:** From memory allocation to error handling, simdjson's design avoids surprises.
- **Peer Reviewed:** Our research appears in venues like VLDB Journal, Software: Practice and Experience.

This library is part of the [Awesome Modern C++](https://awesomecpp.com) list.

## Table of Contents

- [Real-world usage](#real-world-usage)
- [Quick Start](#quick-start)
- [Documentation](#documentation)
- [Godbolt](#godbolt)
- [Performance results](#performance-results)
- [Packages](#packages)
- [Bindings and Ports of simdjson](#bindings-and-ports-of-simdjson)
- [About simdjson](#about-simdjson)
- [Funding](#funding)
- [Contributing to simdjson](#contributing-to-simdjson)
- [License](#license)

## Real-world usage

- [Node.js](https://nodejs.org/)
- [ClickHouse](https://github.com/ClickHouse/ClickHouse)
- [Meta Velox](https://velox-lib.io)
- [Google Pax](https://github.com/google/paxml)
- [milvus](https://github.com/milvus-io/milvus)
- [QuestDB](https://questdb.io/blog/questdb-release-8-0-3/)
- [Clang Build Analyzer](https://github.com/aras-p/ClangBuildAnalyzer)
- [Shopify HeapProfiler](https://github.com/Shopify/heap-profiler)
- [StarRocks](https://github.com/StarRocks/starrocks)
- [Microsoft FishStore](https://github.com/microsoft/FishStore)
- [Intel PCM](https://github.com/intel/pcm)
- [WatermelonDB](https://github.com/Nozbe/WatermelonDB)
- [Apache Doris](https://github.com/apache/doris)
- [Dgraph](https://github.com/dgraph-io/dgraph)
- [UJRPC](https://github.com/unum-cloud/ujrpc)
- [fastgltf](https://github.com/spnda/fastgltf)
- [vast](https://github.com/tenzir/vast)
- [ada-url](https://github.com/ada-url/ada)
- [fastgron](https://github.com/adamritter/fastgron)
- [WasmEdge](https://wasmedge.org)
- [RonDB](https://github.com/logicalclocks/rondb)
- [GreptimeDB](https://github.com/GreptimeTeam/greptimedb)
- [mamba](https://github.com/mamba-org/mamba)
- [Ladybird Browser](https://ladybird.org)

If you are planning to use simdjson in a product, please work from one of our releases.

## Quick Start

The simdjson library is easily consumable with a single .h and .cpp file.

0. Prerequisites: `g++` (version 7 or better) or `clang++` (version 6 or better), and a 64-bit
   system with a command-line shell (e.g., Linux, macOS, freeBSD). We also support programming
   environments like Visual Studio and Xcode, but different steps are needed. Users of clang++ may need to specify the C++ version (e.g., `c++ -std=c++17`) since clang++ tends to default on C++98.
1. Pull [simdjson.h](singleheader/simdjson.h) and [simdjson.cpp](singleheader/simdjson.cpp) into a
   directory, along with the sample file [twitter.json](jsonexamples/twitter.json). You can download them with the `wget` utility:

   ```
   wget https://raw.githubusercontent.com/simdjson/simdjson/master/singleheader/simdjson.h https://raw.githubusercontent.com/simdjson/simdjson/master/singleheader/simdjson.cpp https://raw.githubusercontent.com/simdjson/simdjson/master/jsonexamples/twitter.json
   ```

2. Create `quickstart.cpp`:

```cpp
#include <iostream>
#include "simdjson.h"
using namespace simdjson;
int main(void) {
    ondemand::parser parser;
    padded_string json = padded_string::load("twitter.json");
    ondemand::document tweets = parser.iterate(json);
    std::cout << uint64_t(tweets["search_metadata"]["count"]) << " results." << std::endl;
}
```

3. `c++ -o quickstart quickstart.cpp simdjson.cpp`
4. `./quickstart`

```
 100 results.
```

## Documentation

Usage documentation is available:

- [Basics](doc/basics.md) is an overview of how to use simdjson and its APIs.
- [Builder](doc/builder.md) is an overview of how to efficiently write JSON strings using simdjson.
- [Performance](doc/performance.md) shows some more advanced scenarios and how to tune for them.
- [Implementation Selection](doc/implementation-selection.md) describes runtime CPU detection and
  how you can work with it.
- [API](https://simdjson.github.io/simdjson/) contains the automatically generated API documentation.
- [Compile-Time Parsing](doc/compile_time.md) presents our compile-time parsing function (C++26 only).

## Godbolt

Some users may want to browse code along with the compiled assembly. You want to check out the following lists of examples:

- [C++26 reflection example](https://godbolt.org/z/K3Px64TqK)
- [simdjson examples with errors handled through exceptions](https://godbolt.org/z/7G5qE4sr9)
- [simdjson examples with errors without exceptions](https://godbolt.org/z/e9dWb9E4v)

## Performance results

The simdjson library uses three-quarters less instructions than state-of-the-art parser [RapidJSON](https://rapidjson.org). To our knowledge, simdjson is the first fully-validating JSON parser
to run at [gigabytes per second](https://en.wikipedia.org/wiki/Gigabyte) (GB/s) on commodity processors. It can parse millions of JSON documents per second on a single core.

The following figure represents parsing speed in GB/s for parsing various files
on an Intel Skylake processor (3.4 GHz) using the GNU GCC 10 compiler (with the -O3 flag).
We compare against the best and fastest C++ libraries on benchmarks that load and process the data.
The simdjson library offers full unicode ([UTF-8](https://en.wikipedia.org/wiki/UTF-8)) validation and exact
number parsing.

<img src="doc/rome.png" width="60%">

The simdjson library offers high speed whether it processes tiny files (e.g., 300 bytes)
or larger files (e.g., 3MB). The following plot presents parsing
speed for [synthetic files over various sizes generated with a script](https://github.com/simdjson/simdjson_experiments_vldb2019/blob/master/experiments/growing/gen.py) on a 3.4 GHz Skylake processor (GNU GCC 9, -O3).

<img src="doc/growing.png" width="60%">

[All our experiments are reproducible](https://github.com/simdjson/simdjson_experiments_vldb2019).

For NDJSON files, we can exceed 3 GB/s with [our multithreaded parsing functions](https://github.com/simdjson/simdjson/blob/master/doc/parse_many.md).

## Packages

[![Packaging status](https://repology.org/badge/vertical-allrepos/simdjson.svg)](https://repology.org/project/simdjson/versions)

## Bindings and Ports of simdjson

We distinguish between "bindings" (which just wrap the C++ code) and a port to another programming language (which reimplements everything).

- [ZippyJSON](https://github.com/michaeleisel/zippyjson): Swift bindings for the simdjson project.
- [libpy_simdjson](https://github.com/gerrymanoim/libpy_simdjson/): high-speed Python bindings for simdjson using [libpy](https://github.com/quantopian/libpy).
- [pysimdjson](https://github.com/TkTech/pysimdjson): Python bindings for the simdjson project.
- [cysimdjson](https://github.com/TeskaLabs/cysimdjson): high-speed Python bindings for the simdjson project.
- [simdjson-rs](https://github.com/simd-lite): Rust port.
- [simdjson-rust](https://github.com/SunDoge/simdjson-rust): Rust wrapper (bindings).
- [SimdJsonSharp](https://github.com/EgorBo/SimdJsonSharp): C# version for .NET Core (bindings and full port).
- [simdjson_nodejs](https://github.com/luizperes/simdjson_nodejs): Node.js bindings for the simdjson project.
- [simdjson_php](https://github.com/crazyxman/simdjson_php): PHP bindings for the simdjson project.
- [simdjson_ruby](https://github.com/saka1/simdjson_ruby): Ruby bindings for the simdjson project.
- [fast_jsonparser](https://github.com/anilmaurya/fast_jsonparser): Ruby bindings for the simdjson project.
- [simdjson-go](https://github.com/minio/simdjson-go): Go port using Golang assembly.
- [rcppsimdjson](https://github.com/eddelbuettel/rcppsimdjson): R bindings.
- [simdjson_erlang](https://github.com/ChomperT/simdjson_erlang): erlang bindings.
- [simdjsone](https://github.com/saleyn/simdjsone): erlang bindings.
- [lua-simdjson](https://github.com/FourierTransformer/lua-simdjson): lua bindings.
- [hermes-json](https://hackage.haskell.org/package/hermes-json): haskell bindings.
- [zimdjson](https://github.com/EzequielRamis/zimdjson): Zig port.
- [simdjzon](https://github.com/travisstaloch/simdjzon): Zig port.
- [JSON-Simd](https://github.com/rawleyfowler/JSON-simd): Raku bindings.
- [JSON::SIMD](https://metacpan.org/pod/JSON::SIMD): Perl bindings; fully-featured JSON module that uses simdjson for decoding.
- [gemmaJSON](https://github.com/sainttttt/gemmaJSON): Nim JSON parser based on simdjson bindings.
- [simdjson-java](https://github.com/simdjson/simdjson-java): Java port.
- [mruby-fast-json](https://github.com/Asmod4n/mruby-fast-json): mruby binding with high API coverage.

## About simdjson

The simdjson library takes advantage of modern microarchitectures, parallelizing with SIMD vector
instructions, reducing branch misprediction, and reducing data dependency to take advantage of each
CPU's multiple execution cores.

Our default front-end is called On-Demand, and we wrote a paper about it:

- John Keiser, Daniel Lemire, [On-Demand JSON: A Better Way to Parse Documents?](http://arxiv.org/abs/2312.17149), Software: Practice and Experience 54 (6), 2024.

Some people [enjoy reading the first (2019) simdjson paper](https://arxiv.org/abs/1902.08318): A description of the design
and implementation of simdjson is in our research article:

- Geoff Langdale, Daniel Lemire, [Parsing Gigabytes of JSON per Second](https://arxiv.org/abs/1902.08318), VLDB Journal 28 (6), 2019.

We have an in-depth paper focused on the UTF-8 validation:

- John Keiser, Daniel Lemire, [Validating UTF-8 In Less Than One Instruction Per Byte](https://arxiv.org/abs/2010.03090), Software: Practice & Experience 51 (5), 2021.

We also have an informal [blog post providing some background and context](https://branchfree.org/2019/02/25/paper-parsing-gigabytes-of-json-per-second/).

For the video inclined, <br />
[![simdjson at QCon San Francisco 2019](http://img.youtube.com/vi/wlvKAT7SZIQ/0.jpg)](http://www.youtube.com/watch?v=wlvKAT7SZIQ)<br />
(It was the best voted talk, we're kinda proud of it.)

## Citing this work

If you use simdjson in published research, please cite the software library. A suitable BibTeX entry is:

```bibtex
@misc{simdjson,
  title={{The simdjson library: Parsing Gigabytes of JSON per Second}},
  author={Daniel Lemire and Geoff Langdale and John Keiser and Paul Dreik and Francisco Thiesen and others},
  year={2019},
  howpublished={Software library},
  note={https://github.com/simdjson/simdjson}
}
```

## Funding

The work is supported by the Natural Sciences and Engineering Research Council of Canada under grants
RGPIN-2017-03910 and RGPIN-2024-03787.

[license]: LICENSE
[license img]: https://img.shields.io/badge/License-Apache%202-blue.svg
[licensemit]: LICENSE-MIT
[licensemit img]: https://img.shields.io/badge/License-MIT-blue.svg

## Contributing to simdjson

Head over to [CONTRIBUTING.md](CONTRIBUTING.md) for information on contributing to simdjson, and
[HACKING.md](HACKING.md) for information on source, building, and architecture/design.

## Stars

[![Star History Chart](https://api.star-history.com/svg?repos=simdjson/simdjson&type=Date)](https://www.star-history.com/#simdjson/simdjson&Date)

## License

This code is made available under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.html) as well as under the MIT License. As a user, you can pick the license you prefer.

Under Windows, we build some tools using the windows/dirent_portable.h file (which is outside our library code): it is under the liberal (business-friendly) MIT license.

For compilers that do not support [C++17](https://en.wikipedia.org/wiki/C%2B%2B17), we bundle the string-view library which is published under the [Boost license](http://www.boost.org/LICENSE_1_0.txt). Like the Apache license, the Boost license is a permissive license allowing commercial redistribution.

For efficient number serialization, we bundle Florian Loitsch's implementation of the Grisu2 algorithm for binary to decimal floating-point numbers. The implementation was slightly modified by JSON for Modern C++ library. Both Florian Loitsch's implementation and JSON for Modern C++ are provided under the MIT license.

For runtime dispatching, we use some code from the PyTorch project licensed under 3-clause BSD.
