# Jetson Xavier Installation Guide for LLM Inference (llm.cpp)

This guide shows how to set up a **minimal Ubuntu 20.04** base on Jetson AGX Xavier / Xavier NX using the `pythops/jetson-image` tool, add the JetPack 5.x runtime (CUDA, cuDNN, TensorRT, drivers), and build & run **llm.cpp** with CUDA acceleration. The result keeps the rootfs small (~2‑3 GB) leaving ample RAM for model weights on an 8 GB device.

---

## Prerequisites

- Host PC with Ubuntu 20.04/22.04 (or any Linux with Docker) to build the image.
- Jetson Xavier developer kit (or module) with an empty SD card ≥ 16 GB or eMMC.
- Internet connection for package downloads.
- Basic familiarity with the command line.

---

## 1️⃣ Build a Minimal Ubuntu 20.04 Image

We’ll use the community‑maintained `pythops/jetson-image` repository, which creates a tiny Ubuntu rootfs tailored for Jetson boards.

```bash
# Clone the repository
git clone https://github.com/pythops/jetson-image.git
cd jetson-image

# Install the `just` runner if you don't have it (optional but recommended)
#   curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | sudo sh -s -- --to /usr/local/bin

# Build the Ubuntu‑20.04 minimal rootfs tarball
just build-jetson-rootfs 20.04
# Output: ubuntu-20.04-minimal.tar.gz (in the repo root)

# Flash the image to an SD card (adjust block device as needed, e.g. /dev/sdb)
# Replace `jetson-agx-xavier` with your exact board if using Xavier NX:
just build-jetson-image -b jetson-agx-xavier -r 300 -d SD
# -r 300 creates a 300 MB rootfs partition; increase if you need more space for extra packages.
```

> **Tip:** If you prefer to use NVIDIA’s L4T tools directly, you can flash the same tarball with `sudo ./flash.sh -r <rootfs-dir> <board> mmcblk0p1` but the `just` target above handles partitioning automatically.

Insert the flashed SD card into the Xavier, power on, and complete the initial Ubuntu setup (create user, set timezone, etc.). Log in via SSH or console.

---

## 2️⃣ Install the JetPack 5.x Runtime (CUDA Stack)

Instead of installing the full JetPack meta‑package (which pulls many extra samples and GUI components), we install only the essential runtime libraries needed for llm.cpp.

```bash
sudo apt update
# Install NVIDIA driver, CUDA toolkit, cuDNN, and TensorRT from the Ubuntu repos (which mirror JetPack 5.x)
sudo apt install -y --no-install-recommends \
    nvidia-driver-525 \
    cuda-toolkit-11-4 \
    libcudnn8-dev \
    tensorrt \
    # Optional but useful for multimedia (video decode/encode) if needed:
    libnvidia-encode-525 \
    libnvidia-decoder-525
```

Verify the installation:

```bash
nvcc --version   # should show CUDA 11.x
cat /etc/nvcudnn.txt   # shows cuDNN version
dpkg -l | grep tensorrt
```

> **Why not `sudo apt install nvidia-jetpack`?**  
> The full meta‑package brings in samples, documentation, GUI tools, and optional components that increase the rootfs size. Installing the individual packages above gives you the same CUDA/cuDNN/TensorRT stack with a smaller footprint.

---

## 3️⃣ Build llm.cpp with CUDA Acceleration

llm.cpp (the ggml‑based LLM inference library) can leverage cuBLAS for GPU‑accelerated matrix multiplication.

```bash
git clone https://github.com/ggml-org/llm.cpp.git
cd llm.cpp

# Enable cuBLAS (GPU GEMM) – this is the main acceleration for LLMs.
# If you also want to offload entire layers to GPU, you may need GGML_CUDA=1 (check branch).
LLAMA_CUBLAS=1 make -j$(nproc)

# The binary `./main` will now be created.
```

### Optional: Full GPU Offload (if your model fits in VRAM)

Some recent llm.cpp branches support `GGML_CUDA=1` to place tensors on the GPU. Check the branch’s README; if available:

```bash
LLAMA_CUBLAS=1 GGML_CUDA=1 make -j$(nproc)
```

---

## 4️⃣ Run a Quantized LLM Example

Download a small, quantized model in GGUF format (e.g., Phi‑2, TinyLlama, or Gemma‑2B). Quantizations like Q4_K_M or Q5_K_M give a good balance of size and quality.

```bash
# Example: fetch Phi‑2‑Q4_K_M.gguf (approx 1.9 GB)
wget https://huggingface.co/TheBloke/phi-2-GGUF/resolve/main/phi-2.q4_k_m.gguf

# Run a simple prompt
./main -m phi-2.q4_k_m.gguf -p "Explain quantum computing in simple terms:" -n 128
```

You should see tokens generated at a rate of several tokens per second (depends on model size and Xavier’s GPU). Monitor GPU utilization with:

```bash
sudo tegrastats
```

Look for the `GR3D` field (GPU load) and `RAM` usage.

---

## 5️⃣ Keeping the Image Small (Post‑Install Cleanup)

After installing the CUDA stack and building llm.cpp, you can clean apt caches and remove unneeded locales/docs:

```bash
sudo apt clean
sudo rm -rf /var/lib/apt/lists/*
sudo localepurge   # if installed; otherwise install and run to keep only needed locales
# Remove documentation and examples to save space
sudo rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/groff/* /usr/share/info/*
sudo rm -rf /usr/share/lintian/* /usr/share/linda/* /var/cache/man/*
```

Typical resulting rootfs usage for a **minimal Jetson Xavier LLM inference system**:

- Base Ubuntu 20.04 (minimal, from pythops/jetson-image): **~500-700 MB**  
  (The `just build-jetson-rootfs 20.04` creates a ~300MB tarball; after flashing and minimal setup, it's ~500-700MB)
- Essential JetPack 5.x runtime (driver + CUDA 11.4 + cuDNN + TensorRT): **~800MB-1.1GB**  
  (Installing only `nvidia-driver-525`, `cuda-toolkit-11-4`, `libcudnn8-dev`, `tensorrt` keeps it minimal)
- llm.cpp build: **~100-200MB**
- Working space for model & context: **Remaining RAM** (e.g., 5-6GB on 8GB device for a 2-3GB quantized model)

**Total flashed image size**: Often **under 2GB** for the OS + JetPack runtime, leaving ample space for models and data.

> 💡 **For absolute minimum**: Consider NVIDIA's "Minimal L4T" approach (flash only kernel + minimal userspace) then install CUDA components manually. This can reduce the base OS to ~300-400MB before adding JetPack components.

---

## 6️⃣ Alternatives & Notes

| Option                                                            | When to use                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Full JetPack meta‑package** (`sudo apt install nvidia-jetpack`) | If you need the full SDK (samples, multimedia APIs, VisionWorks, etc.) and size is not critical.                                                                                                                                                                                                             |
| **Containerized development**                                     | Keep the host OS minimal (Ubuntu 20.04 + JetPack) and run your application inside a Docker/Podman container with Ubuntu 22.04 (or any distro) that mounts `/usr/local/cuda` and `/usr/lib/aarch64-linux-gnu/tegra` from the host. This gives you a newer userspace while preserving the validated GPU stack. |
| **Minimal L4T approach**                                          | For the absolute smallest image, flash only the L4T kernel + minimal userspace (see NVIDIA’s “Option: Minimal L4T” guide) then manually install the CUDA packages as above.                                                                                                                                  |

### Compatibility Note

- **JetPack 5.x** = Ubuntu 20.04 + CUDA 11.x.
- **JetPack 6.x** requires Ubuntu 22.04 but is **only officially supported on Jetson Orin/Thor series**, not Xavier/Xavier NX. Attempting to use JetPack 6 on Xavier will fail or lack support.

---

## 7️⃣ Troubleshooting

- **"undefined symbol: cublasGetVersion_v2"** – Ensure `LLAMA_CUBLAS=1` was set when building llm.cpp and that the CUDA toolkit libraries are discoverable (`ldconfig -p | grep libcublas`).
- **Low GPU utilization** – Verify the model is actually using the GPU (check `tegrastats` GR3D > 0%). Some small models may be memory‑bound; try a larger batch size or increase `-n` (tokens to generate) to better amortize overhead.
- **Out‑of‑memory** – Reduce model size (use a more aggressive quantization) or split the model with `ggml-split` if supported.

---

## References

- pythops/jetson-image: https://github.com/pythops/jetson-image
- llm.cpp: https://github.com/ggml-org/llm.cpp
- NVIDIA JetPack 5.x Archive: https://developer.nvidia.com/embedded/jetpack-linux-archive
- tegrastats (part of Jetson utilities): installed with JetPack.

---

**Happy inference on your Jetson Xavier!** If you encounter any issues, feel free to open an issue on the respective repositories or ask in the NVIDIA Developer Forums.
