/*
 * Copyright (c) 2023-2026 The ggml authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

#pragma once

#include "ggml-backend.h"
#include "ggml.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Maximum number of CANN devices supported.
 */
#define GGML_CANN_MAX_DEVICES 16

GGML_BACKEND_API ggml_backend_reg_t ggml_backend_cann_reg(void);

/**
 * @brief Initializes the CANN backend for a specified device.
 *
 * This function initializes the CANN backend for the given device.
 * It verifies the device index, allocates a context, and creates a backend
 * instance.
 *
 * @param device The index of the device to initialize.
 * @return A pointer to the initialized backend instance, or nullptr on failure.
 */
GGML_BACKEND_API ggml_backend_t ggml_backend_cann_init(int32_t device);

/**
 * @brief Checks if a given backend is a CANN backend.
 *
 * This function verifies if the provided backend is a CANN backend by comparing
 * its GUID with the CANN backend's GUID.
 *
 * @param backend The backend instance to check.
 * @return True if the backend is a CANN backend, false otherwise.
 */
GGML_BACKEND_API bool ggml_backend_is_cann(ggml_backend_t backend);

/**
 * @brief Retrieves the CANN buffer type for a specified device.
 *
 * This function initializes and returns the buffer type interface associated
 * with the given device. It ensures thread-safe access using a mutex.
 *
 * @param device The device index for which to retrieve the buffer type.
 * @return A pointer to the buffer type interface for the specified device, or
 * nullptr if the device index is out of range.
 */
GGML_BACKEND_API ggml_backend_buffer_type_t
ggml_backend_cann_buffer_type(int32_t device);

/**
 * @brief Retrieves the number of CANN devices available.
 *
 * This function returns the number of CANN devices available based on
 * information obtained from `ggml_cann_info()`.
 *
 * @return The number of CANN devices available.
 */
GGML_BACKEND_API int32_t ggml_backend_cann_get_device_count(void);

/**
 * @brief pinned host buffer for use with the CPU backend for faster copies between CPU and NPU.
 *
 * @return A pointer to the host buffer type interface.
 */
GGML_BACKEND_API ggml_backend_buffer_type_t ggml_backend_cann_host_buffer_type(void);

/**
 * @brief Retrieves the description of a specific CANN device.
 *
 * This function sets the specified device, retrieves the SoC name,
 * and writes it into the provided description buffer.
 *
 * @param device The device index to retrieve the description for.
 * @param description Pointer to a buffer where the description will be written.
 * @param description_size Size of the description buffer.
 */
GGML_BACKEND_API void ggml_backend_cann_get_device_description(
    int32_t device, char* description, size_t description_size);

/**
 * @brief Retrieves the memory information of a specific CANN device.
 *
 * This function sets the specified device, retrieves the free and total
 * memory information of the specified type (ACL_HBM_MEM), and stores them
 * in the provided pointers.
 *
 * @param device The device index to retrieve memory information for.
 * @param free Pointer to a variable where the free memory size will be stored.
 * @param total Pointer to a variable where the total memory size will be
 * stored.
 */
GGML_BACKEND_API void ggml_backend_cann_get_device_memory(int32_t device,
                                                  size_t* free,
                                                  size_t* total);

#ifdef __cplusplus
}
#endif
