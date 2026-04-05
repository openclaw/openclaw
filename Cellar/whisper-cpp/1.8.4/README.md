# whisper.cpp

![whisper.cpp](https://user-images.githubusercontent.com/1991296/235238348-05d0f6a4-da44-4900-a1de-d0707e75b763.jpeg)

[![Actions Status](https://github.com/ggml-org/whisper.cpp/workflows/CI/badge.svg)](https://github.com/ggml-org/whisper.cpp/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Conan Center](https://shields.io/conan/v/whisper-cpp)](https://conan.io/center/whisper-cpp)
[![npm](https://img.shields.io/npm/v/whisper.cpp.svg)](https://www.npmjs.com/package/whisper.cpp/)

Stable: [v1.8.1](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.8.1) / [Roadmap](https://github.com/orgs/ggml-org/projects/4/)

High-performance inference of [OpenAI's Whisper](https://github.com/openai/whisper) automatic speech recognition (ASR) model:

- Plain C/C++ implementation without dependencies
- Apple Silicon first-class citizen - optimized via ARM NEON, Accelerate framework, Metal and [Core ML](#core-ml-support)
- AVX intrinsics support for x86 architectures
- [VSX intrinsics support for POWER architectures](#power-vsx-intrinsics)
- Mixed F16 / F32 precision
- [Integer quantization support](#quantization)
- Zero memory allocations at runtime
- [Vulkan support](#vulkan-gpu-support)
- Support for CPU-only inference
- [Efficient GPU support for NVIDIA](#nvidia-gpu-support)
- [OpenVINO Support](#openvino-support)
- [Ascend NPU Support](#ascend-npu-support)
- [Moore Threads GPU Support](#moore-threads-gpu-support)
- [C-style API](https://github.com/ggml-org/whisper.cpp/blob/master/include/whisper.h)
- [Voice Activity Detection (VAD)](#voice-activity-detection-vad)

Supported platforms:

- [x] Mac OS (Intel and Arm)
- [x] [iOS](examples/whisper.objc)
- [x] [Android](examples/whisper.android)
- [x] [Java](bindings/java/README.md)
- [x] Linux / [FreeBSD](https://github.com/ggml-org/whisper.cpp/issues/56#issuecomment-1350920264)
- [x] [WebAssembly](examples/whisper.wasm)
- [x] Windows ([MSVC](https://github.com/ggml-org/whisper.cpp/blob/master/.github/workflows/build.yml#L117-L144) and [MinGW](https://github.com/ggml-org/whisper.cpp/issues/168))
- [x] [Raspberry Pi](https://github.com/ggml-org/whisper.cpp/discussions/166)
- [x] [Docker](https://github.com/ggml-org/whisper.cpp/pkgs/container/whisper.cpp)

The entire high-level implementation of the model is contained in [whisper.h](include/whisper.h) and [whisper.cpp](src/whisper.cpp).
The rest of the code is part of the [`ggml`](https://github.com/ggml-org/ggml) machine learning library.

Having such a lightweight implementation of the model allows to easily integrate it in different platforms and applications.
As an example, here is a video of running the model on an iPhone 13 device - fully offline, on-device: [whisper.objc](examples/whisper.objc)

https://user-images.githubusercontent.com/1991296/197385372-962a6dea-bca1-4d50-bf96-1d8c27b98c81.mp4

You can also easily make your own offline voice assistant application: [command](examples/command)

https://user-images.githubusercontent.com/1991296/204038393-2f846eae-c255-4099-a76d-5735c25c49da.mp4

On Apple Silicon, the inference runs fully on the GPU via Metal:

https://github.com/ggml-org/whisper.cpp/assets/1991296/c82e8f86-60dc-49f2-b048-d2fdbd6b5225

## Quick start

First clone the repository:

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
```

Navigate into the directory:

```
cd whisper.cpp
```

Then, download one of the Whisper [models](models/README.md) converted in [`ggml` format](#ggml-format). For example:

```bash
sh ./models/download-ggml-model.sh base.en
```

Now build the [whisper-cli](examples/cli) example and transcribe an audio file like this:

```bash
# build the project
cmake -B build
cmake --build build -j --config Release

# transcribe an audio file
./build/bin/whisper-cli -f samples/jfk.wav
```

---

For a quick demo, simply run `make base.en`.

The command downloads the `base.en` model converted to custom `ggml` format and runs the inference on all `.wav` samples in the folder `samples`.

For detailed usage instructions, run: `./build/bin/whisper-cli -h`

Note that the [whisper-cli](examples/cli) example currently runs only with 16-bit WAV files, so make sure to convert your input before running the tool.
For example, you can use `ffmpeg` like this:

```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav
```

## More audio samples

If you want some extra audio samples to play with, simply run:

```
make -j samples
```

This will download a few more audio files from Wikipedia and convert them to 16-bit WAV format via `ffmpeg`.

You can download and run the other models as follows:

```
make -j tiny.en
make -j tiny
make -j base.en
make -j base
make -j small.en
make -j small
make -j medium.en
make -j medium
make -j large-v1
make -j large-v2
make -j large-v3
make -j large-v3-turbo
```

## Memory usage

| Model  | Disk    | Mem     |
| ------ | ------- | ------- |
| tiny   | 75 MiB  | ~273 MB |
| base   | 142 MiB | ~388 MB |
| small  | 466 MiB | ~852 MB |
| medium | 1.5 GiB | ~2.1 GB |
| large  | 2.9 GiB | ~3.9 GB |

## POWER VSX Intrinsics

`whisper.cpp` supports POWER architectures and includes code which
significantly speeds operation on Linux running on POWER9/10, making it
capable of faster-than-realtime transcription on underclocked Raptor
Talos II. Ensure you have a BLAS package installed, and replace the
standard cmake setup with:

```bash
# build with GGML_BLAS defined
cmake -B build -DGGML_BLAS=1
cmake --build build -j --config Release
./build/bin/whisper-cli [ .. etc .. ]
```

## Quantization

`whisper.cpp` supports integer quantization of the Whisper `ggml` models.
Quantized models require less memory and disk space and depending on the hardware can be processed more efficiently.

Here are the steps for creating and using a quantized model:

```bash
# quantize a model with Q5_0 method
cmake -B build
cmake --build build -j --config Release
./build/bin/quantize models/ggml-base.en.bin models/ggml-base.en-q5_0.bin q5_0

# run the examples as usual, specifying the quantized model file
./build/bin/whisper-cli -m models/ggml-base.en-q5_0.bin ./samples/gb0.wav
```

## Core ML support

On Apple Silicon devices, the Encoder inference can be executed on the Apple Neural Engine (ANE) via Core ML. This can result in significant
speed-up - more than x3 faster compared with CPU-only execution. Here are the instructions for generating a Core ML model and using it with `whisper.cpp`:

- Install Python dependencies needed for the creation of the Core ML model:

  ```bash
  pip install ane_transformers
  pip install openai-whisper
  pip install coremltools
  ```

  - To ensure `coremltools` operates correctly, please confirm that [Xcode](https://developer.apple.com/xcode/) is installed and execute `xcode-select --install` to install the command-line tools.
  - Python 3.11 is recommended.
  - MacOS Sonoma (version 14) or newer is recommended, as older versions of MacOS might experience issues with transcription hallucination.
  - [OPTIONAL] It is recommended to utilize a Python version management system, such as [Miniconda](https://docs.conda.io/en/latest/miniconda.html) for this step:
    - To create an environment, use: `conda create -n py311-whisper python=3.11 -y`
    - To activate the environment, use: `conda activate py311-whisper`

- Generate a Core ML model. For example, to generate a `base.en` model, use:

  ```bash
  ./models/generate-coreml-model.sh base.en
  ```

  This will generate the folder `models/ggml-base.en-encoder.mlmodelc`

- Build `whisper.cpp` with Core ML support:

  ```bash
  # using CMake
  cmake -B build -DWHISPER_COREML=1
  cmake --build build -j --config Release
  ```

- Run the examples as usual. For example:

  ```text
  $ ./build/bin/whisper-cli -m models/ggml-base.en.bin -f samples/jfk.wav

  ...

  whisper_init_state: loading Core ML model from 'models/ggml-base.en-encoder.mlmodelc'
  whisper_init_state: first run on a device may take a while ...
  whisper_init_state: Core ML model loaded

  system_info: n_threads = 4 / 10 | AVX = 0 | AVX2 = 0 | AVX512 = 0 | FMA = 0 | NEON = 1 | ARM_FMA = 1 | F16C = 0 | FP16_VA = 1 | WASM_SIMD = 0 | BLAS = 1 | SSE3 = 0 | VSX = 0 | COREML = 1 |

  ...
  ```

  The first run on a device is slow, since the ANE service compiles the Core ML model to some device-specific format.
  Next runs are faster.

For more information about the Core ML implementation please refer to PR [#566](https://github.com/ggml-org/whisper.cpp/pull/566).

## OpenVINO support

On platforms that support [OpenVINO](https://github.com/openvinotoolkit/openvino), the Encoder inference can be executed
on OpenVINO-supported devices including x86 CPUs and Intel GPUs (integrated & discrete).

This can result in significant speedup in encoder performance. Here are the instructions for generating the OpenVINO model and using it with `whisper.cpp`:

- First, setup python virtual env. and install python dependencies. Python 3.10 is recommended.

  Windows:

  ```powershell
  cd models
  python -m venv openvino_conv_env
  openvino_conv_env\Scripts\activate
  python -m pip install --upgrade pip
  pip install -r requirements-openvino.txt
  ```

  Linux and macOS:

  ```bash
  cd models
  python3 -m venv openvino_conv_env
  source openvino_conv_env/bin/activate
  python -m pip install --upgrade pip
  pip install -r requirements-openvino.txt
  ```

- Generate an OpenVINO encoder model. For example, to generate a `base.en` model, use:

  ```
  python convert-whisper-to-openvino.py --model base.en
  ```

  This will produce ggml-base.en-encoder-openvino.xml/.bin IR model files. It's recommended to relocate these to the same folder as `ggml` models, as that
  is the default location that the OpenVINO extension will search at runtime.

- Build `whisper.cpp` with OpenVINO support:

  Download OpenVINO package from [release page](https://github.com/openvinotoolkit/openvino/releases). The recommended version to use is [2024.6.0](https://github.com/openvinotoolkit/openvino/releases/tag/2024.6.0). Ready to use Binaries of the required libraries can be found in the [OpenVino Archives](https://storage.openvinotoolkit.org/repositories/openvino/packages/2024.6/)

  After downloading & extracting package onto your development system, set up required environment by sourcing setupvars script. For example:

  Linux:

  ```bash
  source /path/to/l_openvino_toolkit_ubuntu22_2023.0.0.10926.b4452d56304_x86_64/setupvars.sh
  ```

  Windows (cmd):

  ```powershell
  C:\Path\To\w_openvino_toolkit_windows_2023.0.0.10926.b4452d56304_x86_64\setupvars.bat
  ```

  And then build the project using cmake:

  ```bash
  cmake -B build -DWHISPER_OPENVINO=1
  cmake --build build -j --config Release
  ```

- Run the examples as usual. For example:

  ```text
  $ ./build/bin/whisper-cli -m models/ggml-base.en.bin -f samples/jfk.wav

  ...

  whisper_ctx_init_openvino_encoder: loading OpenVINO model from 'models/ggml-base.en-encoder-openvino.xml'
  whisper_ctx_init_openvino_encoder: first run on a device may take a while ...
  whisper_openvino_init: path_model = models/ggml-base.en-encoder-openvino.xml, device = GPU, cache_dir = models/ggml-base.en-encoder-openvino-cache
  whisper_ctx_init_openvino_encoder: OpenVINO model loaded

  system_info: n_threads = 4 / 8 | AVX = 1 | AVX2 = 1 | AVX512 = 0 | FMA = 1 | NEON = 0 | ARM_FMA = 0 | F16C = 1 | FP16_VA = 0 | WASM_SIMD = 0 | BLAS = 0 | SSE3 = 1 | VSX = 0 | COREML = 0 | OPENVINO = 1 |

  ...
  ```

  The first time run on an OpenVINO device is slow, since the OpenVINO framework will compile the IR (Intermediate Representation) model to a device-specific 'blob'. This device-specific blob will get
  cached for the next run.

For more information about the OpenVINO implementation please refer to PR [#1037](https://github.com/ggml-org/whisper.cpp/pull/1037).

## NVIDIA GPU support

With NVIDIA cards the processing of the models is done efficiently on the GPU via cuBLAS and custom CUDA kernels.
First, make sure you have installed `cuda`: https://developer.nvidia.com/cuda-downloads

Now build `whisper.cpp` with CUDA support:

```
cmake -B build -DGGML_CUDA=1
cmake --build build -j --config Release
```

or for newer NVIDIA GPU's (RTX 5000 series):

```
cmake -B build -DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES="86"
cmake --build build -j --config Release
```

## Vulkan GPU support

Cross-vendor solution which allows you to accelerate workload on your GPU.
First, make sure your graphics card driver provides support for Vulkan API.

Now build `whisper.cpp` with Vulkan support:

```
cmake -B build -DGGML_VULKAN=1
cmake --build build -j --config Release
```

## BLAS CPU support via OpenBLAS

Encoder processing can be accelerated on the CPU via OpenBLAS.
First, make sure you have installed `openblas`: https://www.openblas.net/

Now build `whisper.cpp` with OpenBLAS support:

```
cmake -B build -DGGML_BLAS=1
cmake --build build -j --config Release
```

## Ascend NPU support

Ascend NPU provides inference acceleration via [`CANN`](https://www.hiascend.com/en/software/cann) and AI cores.

First, check if your Ascend NPU device is supported:

**Verified devices**
| Ascend NPU | Status |
|:-----------------------------:|:-------:|
| Atlas 300T A2 | Support |
| Atlas 300I Duo | Support |

Then, make sure you have installed [`CANN toolkit`](https://www.hiascend.com/en/software/cann/community) . The lasted version of CANN is recommanded.

Now build `whisper.cpp` with CANN support:

```
cmake -B build -DGGML_CANN=1
cmake --build build -j --config Release
```

Run the inference examples as usual, for example:

```
./build/bin/whisper-cli -f samples/jfk.wav -m models/ggml-base.en.bin -t 8
```

_Notes:_

- If you have trouble with Ascend NPU device, please create a issue with **[CANN]** prefix/tag.
- If you run successfully with your Ascend NPU device, please help update the table `Verified devices`.

## Moore Threads GPU support

With Moore Threads cards the processing of the models is done efficiently on the GPU via muBLAS and custom MUSA kernels.
First, make sure you have installed `MUSA SDK rc4.2.0`: https://developer.mthreads.com/sdk/download/musa?equipment=&os=&driverVersion=&version=4.2.0

Now build `whisper.cpp` with MUSA support:

```
cmake -B build -DGGML_MUSA=1
cmake --build build -j --config Release
```

or specify the architecture for your Moore Threads GPU. For example, if you have a MTT S80 GPU, you can specify the architecture as follows:

```
cmake -B build -DGGML_MUSA=1 -DMUSA_ARCHITECTURES="21"
cmake --build build -j --config Release
```

## FFmpeg support (Linux only)

If you want to support more audio formats (such as Opus and AAC), you can turn on the `WHISPER_FFMPEG` build flag to enable FFmpeg integration.

First, you need to install required libraries:

```bash
# Debian/Ubuntu
sudo apt install libavcodec-dev libavformat-dev libavutil-dev

# RHEL/Fedora
sudo dnf install libavcodec-free-devel libavformat-free-devel libavutil-free-devel
```

Then you can build the project as follows:

```bash
cmake -B build -D WHISPER_FFMPEG=yes
cmake --build build
```

Run the following example to confirm it's working:

```bash
# Convert an audio file to Opus format
ffmpeg -i samples/jfk.wav jfk.opus

# Transcribe the audio file
./build/bin/whisper-cli --model models/ggml-base.en.bin --file jfk.opus
```

## Docker

### Prerequisites

- Docker must be installed and running on your system.
- Create a folder to store big models & intermediate files (ex. /whisper/models)

### Images

We have multiple Docker images available for this project:

1. `ghcr.io/ggml-org/whisper.cpp:main`: This image includes the main executable file as well as `curl` and `ffmpeg`. (platforms: `linux/amd64`, `linux/arm64`)
2. `ghcr.io/ggml-org/whisper.cpp:main-cuda`: Same as `main` but compiled with CUDA support. (platforms: `linux/amd64`)
3. `ghcr.io/ggml-org/whisper.cpp:main-musa`: Same as `main` but compiled with MUSA support. (platforms: `linux/amd64`)
4. `ghcr.io/ggml-org/whisper.cpp:main-vulkan`: Same as `main` but compiled with Vulkan support. (platforms: `linux/amd64`)

### Usage

```shell
# download model and persist it in a local folder
docker run -it --rm \
  -v path/to/models:/models \
  whisper.cpp:main "./models/download-ggml-model.sh base /models"

# transcribe an audio file
docker run -it --rm \
  -v path/to/models:/models \
  -v path/to/audios:/audios \
  whisper.cpp:main "whisper-cli -m /models/ggml-base.bin -f /audios/jfk.wav"

# transcribe an audio file in samples folder
docker run -it --rm \
  -v path/to/models:/models \
  whisper.cpp:main "whisper-cli -m /models/ggml-base.bin -f ./samples/jfk.wav"

# run the web server
docker run -it --rm -p "8080:8080" \
  -v path/to/models:/models \
  whisper.cpp:main "whisper-server --host 127.0.0.1 -m /models/ggml-base.bin"

# run the bench too on the small.en model using 4 threads
docker run -it --rm \
  -v path/to/models:/models \
  whisper.cpp:main "whisper-bench -m /models/ggml-small.en.bin -t 4"
```

## Installing with Conan

You can install pre-built binaries for whisper.cpp or build it from source using [Conan](https://conan.io/). Use the following command:

```
conan install --requires="whisper-cpp/[*]" --build=missing
```

For detailed instructions on how to use Conan, please refer to the [Conan documentation](https://docs.conan.io/2/).

## Limitations

- Inference only

## Real-time audio input example

This is a naive example of performing real-time inference on audio from your microphone.
The [stream](examples/stream) tool samples the audio every half a second and runs the transcription continuously.
More info is available in [issue #10](https://github.com/ggml-org/whisper.cpp/issues/10).
You will need to have [sdl2](https://wiki.libsdl.org/SDL2/Installation) installed for it to work properly.

```bash
cmake -B build -DWHISPER_SDL2=ON
cmake --build build -j --config Release
./build/bin/whisper-stream -m ./models/ggml-base.en.bin -t 8 --step 500 --length 5000
```

https://user-images.githubusercontent.com/1991296/194935793-76afede7-cfa8-48d8-a80f-28ba83be7d09.mp4

## Confidence color-coding

Adding the `--print-colors` argument will print the transcribed text using an experimental color coding strategy
to highlight words with high or low confidence:

```bash
./build/bin/whisper-cli -m models/ggml-base.en.bin -f samples/gb0.wav --print-colors
```

<img width="965" alt="image" src="https://user-images.githubusercontent.com/1991296/197356445-311c8643-9397-4e5e-b46e-0b4b4daa2530.png">

## Controlling the length of the generated text segments (experimental)

For example, to limit the line length to a maximum of 16 characters, simply add `-ml 16`:

```text
$ ./build/bin/whisper-cli -m ./models/ggml-base.en.bin -f ./samples/jfk.wav -ml 16

whisper_model_load: loading model from './models/ggml-base.en.bin'
...
system_info: n_threads = 4 / 10 | AVX2 = 0 | AVX512 = 0 | NEON = 1 | FP16_VA = 1 | WASM_SIMD = 0 | BLAS = 1 |

main: processing './samples/jfk.wav' (176000 samples, 11.0 sec), 4 threads, 1 processors, lang = en, task = transcribe, timestamps = 1 ...

[00:00:00.000 --> 00:00:00.850]   And so my
[00:00:00.850 --> 00:00:01.590]   fellow
[00:00:01.590 --> 00:00:04.140]   Americans, ask
[00:00:04.140 --> 00:00:05.660]   not what your
[00:00:05.660 --> 00:00:06.840]   country can do
[00:00:06.840 --> 00:00:08.430]   for you, ask
[00:00:08.430 --> 00:00:09.440]   what you can do
[00:00:09.440 --> 00:00:10.020]   for your
[00:00:10.020 --> 00:00:11.000]   country.
```

## Word-level timestamp (experimental)

The `--max-len` argument can be used to obtain word-level timestamps. Simply use `-ml 1`:

```text
$ ./build/bin/whisper-cli -m ./models/ggml-base.en.bin -f ./samples/jfk.wav -ml 1

whisper_model_load: loading model from './models/ggml-base.en.bin'
...
system_info: n_threads = 4 / 10 | AVX2 = 0 | AVX512 = 0 | NEON = 1 | FP16_VA = 1 | WASM_SIMD = 0 | BLAS = 1 |

main: processing './samples/jfk.wav' (176000 samples, 11.0 sec), 4 threads, 1 processors, lang = en, task = transcribe, timestamps = 1 ...

[00:00:00.000 --> 00:00:00.320]
[00:00:00.320 --> 00:00:00.370]   And
[00:00:00.370 --> 00:00:00.690]   so
[00:00:00.690 --> 00:00:00.850]   my
[00:00:00.850 --> 00:00:01.590]   fellow
[00:00:01.590 --> 00:00:02.850]   Americans
[00:00:02.850 --> 00:00:03.300]  ,
[00:00:03.300 --> 00:00:04.140]   ask
[00:00:04.140 --> 00:00:04.990]   not
[00:00:04.990 --> 00:00:05.410]   what
[00:00:05.410 --> 00:00:05.660]   your
[00:00:05.660 --> 00:00:06.260]   country
[00:00:06.260 --> 00:00:06.600]   can
[00:00:06.600 --> 00:00:06.840]   do
[00:00:06.840 --> 00:00:07.010]   for
[00:00:07.010 --> 00:00:08.170]   you
[00:00:08.170 --> 00:00:08.190]  ,
[00:00:08.190 --> 00:00:08.430]   ask
[00:00:08.430 --> 00:00:08.910]   what
[00:00:08.910 --> 00:00:09.040]   you
[00:00:09.040 --> 00:00:09.320]   can
[00:00:09.320 --> 00:00:09.440]   do
[00:00:09.440 --> 00:00:09.760]   for
[00:00:09.760 --> 00:00:10.020]   your
[00:00:10.020 --> 00:00:10.510]   country
[00:00:10.510 --> 00:00:11.000]  .
```

## Speaker segmentation via tinydiarize (experimental)

More information about this approach is available here: https://github.com/ggml-org/whisper.cpp/pull/1058

Sample usage:

```py
# download a tinydiarize compatible model
./models/download-ggml-model.sh small.en-tdrz

# run as usual, adding the "-tdrz" command-line argument
./build/bin/whisper-cli -f ./samples/a13.wav -m ./models/ggml-small.en-tdrz.bin -tdrz
...
main: processing './samples/a13.wav' (480000 samples, 30.0 sec), 4 threads, 1 processors, lang = en, task = transcribe, tdrz = 1, timestamps = 1 ...
...
[00:00:00.000 --> 00:00:03.800]   Okay Houston, we've had a problem here. [SPEAKER_TURN]
[00:00:03.800 --> 00:00:06.200]   This is Houston. Say again please. [SPEAKER_TURN]
[00:00:06.200 --> 00:00:08.260]   Uh Houston we've had a problem.
[00:00:08.260 --> 00:00:11.320]   We've had a main beam up on a volt. [SPEAKER_TURN]
[00:00:11.320 --> 00:00:13.820]   Roger main beam interval. [SPEAKER_TURN]
[00:00:13.820 --> 00:00:15.100]   Uh uh [SPEAKER_TURN]
[00:00:15.100 --> 00:00:18.020]   So okay stand, by thirteen we're looking at it. [SPEAKER_TURN]
[00:00:18.020 --> 00:00:25.740]   Okay uh right now uh Houston the uh voltage is uh is looking good um.
[00:00:27.620 --> 00:00:29.940]   And we had a a pretty large bank or so.
```

## Karaoke-style movie generation (experimental)

The [whisper-cli](examples/cli) example provides support for output of karaoke-style movies, where the
currently pronounced word is highlighted. Use the `-owts` argument and run the generated bash script.
This requires to have `ffmpeg` installed.

Here are a few _"typical"_ examples:

```bash
./build/bin/whisper-cli -m ./models/ggml-base.en.bin -f ./samples/jfk.wav -owts
source ./samples/jfk.wav.wts
ffplay ./samples/jfk.wav.mp4
```

https://user-images.githubusercontent.com/1991296/199337465-dbee4b5e-9aeb-48a3-b1c6-323ac4db5b2c.mp4

---

```bash
./build/bin/whisper-cli -m ./models/ggml-base.en.bin -f ./samples/mm0.wav -owts
source ./samples/mm0.wav.wts
ffplay ./samples/mm0.wav.mp4
```

https://user-images.githubusercontent.com/1991296/199337504-cc8fd233-0cb7-4920-95f9-4227de3570aa.mp4

---

```bash
./build/bin/whisper-cli -m ./models/ggml-base.en.bin -f ./samples/gb0.wav -owts
source ./samples/gb0.wav.wts
ffplay ./samples/gb0.wav.mp4
```

https://user-images.githubusercontent.com/1991296/199337538-b7b0c7a3-2753-4a88-a0cd-f28a317987ba.mp4

---

## Video comparison of different models

Use the [scripts/bench-wts.sh](https://github.com/ggml-org/whisper.cpp/blob/master/scripts/bench-wts.sh) script to generate a video in the following format:

```bash
./scripts/bench-wts.sh samples/jfk.wav
ffplay ./samples/jfk.wav.all.mp4
```

https://user-images.githubusercontent.com/1991296/223206245-2d36d903-cf8e-4f09-8c3b-eb9f9c39d6fc.mp4

---

## Benchmarks

In order to have an objective comparison of the performance of the inference across different system configurations,
use the [whisper-bench](examples/bench) tool. The tool simply runs the Encoder part of the model and prints how much time it
took to execute it. The results are summarized in the following Github issue:

[Benchmark results](https://github.com/ggml-org/whisper.cpp/issues/89)

Additionally a script to run whisper.cpp with different models and audio files is provided [bench.py](scripts/bench.py).

You can run it with the following command, by default it will run against any standard model in the models folder.

```bash
python3 scripts/bench.py -f samples/jfk.wav -t 2,4,8 -p 1,2
```

It is written in python with the intention of being easy to modify and extend for your benchmarking use case.

It outputs a csv file with the results of the benchmarking.

## `ggml` format

The original models are converted to a custom binary format. This allows to pack everything needed into a single file:

- model parameters
- mel filters
- vocabulary
- weights

You can download the converted models using the [models/download-ggml-model.sh](models/download-ggml-model.sh) script
or manually from here:

- https://huggingface.co/ggerganov/whisper.cpp

For more details, see the conversion script [models/convert-pt-to-ggml.py](models/convert-pt-to-ggml.py) or [models/README.md](models/README.md).

## [Bindings](https://github.com/ggml-org/whisper.cpp/discussions/categories/bindings)

- [x] Rust: [tazz4843/whisper-rs](https://github.com/tazz4843/whisper-rs) | [#310](https://github.com/ggml-org/whisper.cpp/discussions/310)
- [x] JavaScript: [bindings/javascript](bindings/javascript) | [#309](https://github.com/ggml-org/whisper.cpp/discussions/309)
  - React Native (iOS / Android): [whisper.rn](https://github.com/mybigday/whisper.rn)
- [x] Go: [bindings/go](bindings/go) | [#312](https://github.com/ggml-org/whisper.cpp/discussions/312)
- [x] Java:
  - [GiviMAD/whisper-jni](https://github.com/GiviMAD/whisper-jni)
- [x] Ruby: [bindings/ruby](bindings/ruby) | [#507](https://github.com/ggml-org/whisper.cpp/discussions/507)
- [x] Objective-C / Swift: [ggml-org/whisper.spm](https://github.com/ggml-org/whisper.spm) | [#313](https://github.com/ggml-org/whisper.cpp/discussions/313)
  - [exPHAT/SwiftWhisper](https://github.com/exPHAT/SwiftWhisper)
- [x] .NET: | [#422](https://github.com/ggml-org/whisper.cpp/discussions/422)
  - [sandrohanea/whisper.net](https://github.com/sandrohanea/whisper.net)
  - [NickDarvey/whisper](https://github.com/NickDarvey/whisper)
- [x] Python: | [#9](https://github.com/ggml-org/whisper.cpp/issues/9)
  - [stlukey/whispercpp.py](https://github.com/stlukey/whispercpp.py) (Cython)
  - [AIWintermuteAI/whispercpp](https://github.com/AIWintermuteAI/whispercpp) (Updated fork of aarnphm/whispercpp)
  - [aarnphm/whispercpp](https://github.com/aarnphm/whispercpp) (Pybind11)
  - [abdeladim-s/pywhispercpp](https://github.com/abdeladim-s/pywhispercpp) (Pybind11)
- [x] R: [bnosac/audio.whisper](https://github.com/bnosac/audio.whisper)
- [x] Unity: [macoron/whisper.unity](https://github.com/Macoron/whisper.unity)

## XCFramework

The XCFramework is a precompiled version of the library for iOS, visionOS, tvOS,
and macOS. It can be used in Swift projects without the need to compile the
library from source. For example, the v1.7.5 version of the XCFramework can be
used as follows:

```swift
// swift-tools-version: 5.10
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "Whisper",
    targets: [
        .executableTarget(
            name: "Whisper",
            dependencies: [
                "WhisperFramework"
            ]),
        .binaryTarget(
            name: "WhisperFramework",
            url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.5/whisper-v1.7.5-xcframework.zip",
            checksum: "c7faeb328620d6012e130f3d705c51a6ea6c995605f2df50f6e1ad68c59c6c4a"
        )
    ]
)
```

## Voice Activity Detection (VAD)

Support for Voice Activity Detection (VAD) can be enabled using the `--vad`
argument to `whisper-cli`. In addition to this option a VAD model is also
required.

The way this works is that first the audio samples are passed through
the VAD model which will detect speech segments. Using this information,
only the speech segments that are detected are extracted from the original audio
input and passed to whisper for processing. This reduces the amount of audio
data that needs to be processed by whisper and can significantly speed up the
transcription process.

The following VAD models are currently supported:

### Silero-VAD

[Silero-vad](https://github.com/snakers4/silero-vad) is a lightweight VAD model
written in Python that is fast and accurate.

Models can be downloaded by running the following command on Linux or MacOS:

```console
$ ./models/download-vad-model.sh silero-v6.2.0
Downloading ggml model silero-v6.2.0 from 'https://huggingface.co/ggml-org/whisper-vad' ...
ggml-silero-v6.2.0.bin        100%[==============================================>] 864.35K  --.-KB/s    in 0.04s
Done! Model 'silero-v6.2.0' saved in '/path/models/ggml-silero-v6.2.0.bin'
You can now use it like this:

  $ ./build/bin/whisper-cli -vm /path/models/ggml-silero-v6.2.0.bin --vad -f samples/jfk.wav -m models/ggml-base.en.bin

```

And the following command on Windows:

```console
> .\models\download-vad-model.cmd silero-v6.2.0
Downloading vad model silero-v6.2.0...
Done! Model silero-v6.2.0 saved in C:\Users\danie\work\ai\whisper.cpp\ggml-silero-v6.2.0.bin
You can now use it like this:

C:\path\build\bin\Release\whisper-cli.exe -vm C:\path\ggml-silero-v6.2.0.bin --vad -m models/ggml-base.en.bin -f samples\jfk.wav

```

To see a list of all available models, run the above commands without any
arguments.

This model can be also be converted manually to ggml using the following command:

```console
$ python3 -m venv venv && source venv/bin/activate
$ (venv) pip install silero-vad
$ (venv) $ python models/convert-silero-vad-to-ggml.py --output models/silero.bin
Saving GGML Silero-VAD model to models/silero-v6.2.0-ggml.bin
```

And it can then be used with whisper as follows:

```console
$ ./build/bin/whisper-cli \
   --file ./samples/jfk.wav \
   --model ./models/ggml-base.en.bin \
   --vad \
   --vad-model ./models/silero-v6.2.0-ggml.bin
```

### VAD Options

- --vad-threshold: Threshold probability for speech detection. A probability
  for a speech segment/frame above this threshold will be considered as speech.

- --vad-min-speech-duration-ms: Minimum speech duration in milliseconds. Speech
  segments shorter than this value will be discarded to filter out brief noise or
  false positives.

- --vad-min-silence-duration-ms: Minimum silence duration in milliseconds. Silence
  periods must be at least this long to end a speech segment. Shorter silence
  periods will be ignored and included as part of the speech.

- --vad-max-speech-duration-s: Maximum speech duration in seconds. Speech segments
  longer than this will be automatically split into multiple segments at silence
  points exceeding 98ms to prevent excessively long segments.

- --vad-speech-pad-ms: Speech padding in milliseconds. Adds this amount of padding
  before and after each detected speech segment to avoid cutting off speech edges.

- --vad-samples-overlap: Amount of audio to extend from each speech segment into
  the next one, in seconds (e.g., 0.10 = 100ms overlap). This ensures speech isn't
  cut off abruptly between segments when they're concatenated together.

## Examples

There are various examples of using the library for different projects in the [examples](examples) folder.
Some of the examples are even ported to run in the browser using WebAssembly. Check them out!

| Example                                             | Web                                   | Description                                                                                                                     |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [whisper-cli](examples/cli)                         | [whisper.wasm](examples/whisper.wasm) | Tool for translating and transcribing audio using Whisper                                                                       |
| [whisper-bench](examples/bench)                     | [bench.wasm](examples/bench.wasm)     | Benchmark the performance of Whisper on your machine                                                                            |
| [whisper-stream](examples/stream)                   | [stream.wasm](examples/stream.wasm)   | Real-time transcription of raw microphone capture                                                                               |
| [whisper-command](examples/command)                 | [command.wasm](examples/command.wasm) | Basic voice assistant example for receiving voice commands from the mic                                                         |
| [whisper-server](examples/server)                   |                                       | HTTP transcription server with OAI-like API                                                                                     |
| [whisper-talk-llama](examples/talk-llama)           |                                       | Talk with a LLaMA bot                                                                                                           |
| [whisper.objc](examples/whisper.objc)               |                                       | iOS mobile application using whisper.cpp                                                                                        |
| [whisper.swiftui](examples/whisper.swiftui)         |                                       | SwiftUI iOS / macOS application using whisper.cpp                                                                               |
| [whisper.android](examples/whisper.android)         |                                       | Android mobile application using whisper.cpp                                                                                    |
| [whisper.nvim](examples/whisper.nvim)               |                                       | Speech-to-text plugin for Neovim                                                                                                |
| [generate-karaoke.sh](examples/generate-karaoke.sh) |                                       | Helper script to easily [generate a karaoke video](https://youtu.be/uj7hVta4blM) of raw audio capture                           |
| [livestream.sh](examples/livestream.sh)             |                                       | [Livestream audio transcription](https://github.com/ggml-org/whisper.cpp/issues/185)                                            |
| [yt-wsp.sh](examples/yt-wsp.sh)                     |                                       | Download + transcribe and/or translate any VOD [(original)](https://gist.github.com/DaniruKun/96f763ec1a037cc92fe1a059b643b818) |
| [wchess](examples/wchess)                           | [wchess.wasm](examples/wchess)        | Voice-controlled chess                                                                                                          |

## [Discussions](https://github.com/ggml-org/whisper.cpp/discussions)

If you have any kind of feedback about this project feel free to use the Discussions section and open a new topic.
You can use the [Show and tell](https://github.com/ggml-org/whisper.cpp/discussions/categories/show-and-tell) category
to share your own projects that use `whisper.cpp`. If you have a question, make sure to check the
[Frequently asked questions (#126)](https://github.com/ggml-org/whisper.cpp/discussions/126) discussion.
