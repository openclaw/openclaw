#pragma once

#include "ggml.h"
#include "ggml-backend.h"

#ifdef  __cplusplus
extern "C" {
#endif

#define GGML_WEBGPU_NAME "WebGPU"

// Needed for examples in ggml
GGML_BACKEND_API ggml_backend_t ggml_backend_webgpu_init(void);

GGML_BACKEND_API ggml_backend_reg_t ggml_backend_webgpu_reg(void);

#ifdef  __cplusplus
}
#endif
