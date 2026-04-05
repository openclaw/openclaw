#pragma once

//
// GGML Tensor Library
//
// This documentation is still a work in progress.
// If you wish some specific topics to be covered, feel free to drop a comment:
//
//   https://github.com/ggml-org/whisper.cpp/issues/40
//
// ## Overview
//
// This library implements:
//
//  - a set of tensor operations
//  - automatic differentiation
//  - basic optimization algorithms
//
// The aim of this library is to provide a minimalistic approach for various machine learning tasks. This includes,
// but is not limited to, the following:
//
//  - linear regression
//  - support vector machines
//  - neural networks
//
// The library allows the user to define a certain function using the available tensor operations. This function
// definition is represented internally via a computation graph. Each tensor operation in the function definition
// corresponds to a node in the graph. Having the computation graph defined, the user can choose to compute the
// function's value and/or its gradient with respect to the input variables. Optionally, the function can be optimized
// using one of the available optimization algorithms.
//
// For example, here we define the function: f(x) = a*x^2 + b
//
//   {
//       struct ggml_init_params params = {
//           .mem_size   = 16*1024*1024,
//           .mem_buffer = NULL,
//       };
//
//       // memory allocation happens here
//       struct ggml_context * ctx = ggml_init(params);
//
//       struct ggml_tensor * x = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
//
//       ggml_set_param(ctx, x); // x is an input variable
//
//       struct ggml_tensor * a  = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
//       struct ggml_tensor * b  = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
//       struct ggml_tensor * x2 = ggml_mul(ctx, x, x);
//       struct ggml_tensor * f  = ggml_add(ctx, ggml_mul(ctx, a, x2), b);
//
//       ...
//   }
//
// Notice that the function definition above does not involve any actual computation. The computation is performed only
// when the user explicitly requests it. For example, to compute the function's value at x = 2.0:
//
//   {
//       ...
//
//       struct ggml_cgraph * gf = ggml_new_graph(ctx);
//       ggml_build_forward_expand(gf, f);
//
//       // set the input variable and parameter values
//       ggml_set_f32(x, 2.0f);
//       ggml_set_f32(a, 3.0f);
//       ggml_set_f32(b, 4.0f);
//
//       ggml_graph_compute_with_ctx(ctx, &gf, n_threads);
//
//       printf("f = %f\n", ggml_get_f32_1d(f, 0));
//
//       ...
//   }
//
// The actual computation is performed in the ggml_graph_compute() function.
//
// The ggml_new_tensor_...() functions create new tensors. They are allocated in the memory buffer provided to the
// ggml_init() function. You have to be careful not to exceed the memory buffer size. Therefore, you have to know
// in advance how much memory you need for your computation. Alternatively, you can allocate a large enough memory
// and after defining the computation graph, call the ggml_used_mem() function to find out how much memory was
// actually needed.
//
// The ggml_set_param() function marks a tensor as an input variable. This is used by the automatic
// differentiation and optimization algorithms.
//
// The described approach allows to define the function graph once and then compute its forward or backward graphs
// multiple times. All computations will use the same memory buffer allocated in the ggml_init() function. This way
// the user can avoid the memory allocation overhead at runtime.
//
// The library supports multi-dimensional tensors - up to 4 dimensions. The FP16 and FP32 data types are first class
// citizens, but in theory the library can be extended to support FP8 and integer data types.
//
// Each tensor operation produces a new tensor. Initially the library was envisioned to support only the use of unary
// and binary operations. Most of the available operations fall into one of these two categories. With time, it became
// clear that the library needs to support more complex operations. The way to support these operations is not clear
// yet, but a few examples are demonstrated in the following operations:
//
//   - ggml_permute()
//   - ggml_conv_1d_1s()
//   - ggml_conv_1d_2s()
//
// For each tensor operator, the library implements a forward and backward computation function. The forward function
// computes the output tensor value given the input tensor values. The backward function computes the adjoint of the
// input tensors given the adjoint of the output tensor. For a detailed explanation of what this means, take a
// calculus class, or watch the following video:
//
//   What is Automatic Differentiation?
//   https://www.youtube.com/watch?v=wG_nF1awSSY
//
//
// ## Tensor data (struct ggml_tensor)
//
// The tensors are stored in memory via the ggml_tensor struct. The structure provides information about the size of
// the tensor, the data type, and the memory buffer where the tensor data is stored. Additionally, it contains
// pointers to the "source" tensors - i.e. the tensors that were used to compute the current tensor. For example:
//
//   {
//       struct ggml_tensor * c = ggml_add(ctx, a, b);
//
//       assert(c->src[0] == a);
//       assert(c->src[1] == b);
//   }
//
// The multi-dimensional tensors are stored in row-major order. The ggml_tensor struct contains fields for the
// number of elements in each dimension ("ne") as well as the number of bytes ("nb", a.k.a. stride). This allows
// to store tensors that are not contiguous in memory, which is useful for operations such as transposition and
// permutation. All tensor operations have to take the stride into account and not assume that the tensor is
// contiguous in memory.
//
// The data of the tensor is accessed via the "data" pointer. For example:
//
//   {
//       const int nx = 2;
//       const int ny = 3;
//
//       struct ggml_tensor * a = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, nx, ny);
//
//       for (int y = 0; y < ny; y++) {
//           for (int x = 0; x < nx; x++) {
//               *(float *) ((char *) a->data + y*a->nb[1] + x*a->nb[0]) = x + y;
//           }
//       }
//
//       ...
//   }
//
// Alternatively, there are helper functions, such as ggml_get_f32_1d() and ggml_set_f32_1d() that can be used.
//
// ## The matrix multiplication operator (ggml_mul_mat)
//
// TODO
//
//
// ## Multi-threading
//
// TODO
//
//
// ## Overview of ggml.c
//
// TODO
//
//
// ## SIMD optimizations
//
// TODO
//
//
// ## Debugging ggml
//
// TODO
//
//

#ifdef GGML_SHARED
#    if defined(_WIN32) && !defined(__MINGW32__)
#        ifdef GGML_BUILD
#            define GGML_API __declspec(dllexport) extern
#        else
#            define GGML_API __declspec(dllimport) extern
#        endif
#    else
#        define GGML_API __attribute__ ((visibility ("default"))) extern
#    endif
#else
#    define GGML_API extern
#endif

// TODO: support for clang
#ifdef __GNUC__
#    define GGML_DEPRECATED(func, hint) func __attribute__((deprecated(hint)))
#elif defined(_MSC_VER)
#    define GGML_DEPRECATED(func, hint) __declspec(deprecated(hint)) func
#else
#    define GGML_DEPRECATED(func, hint) func
#endif

#ifndef __GNUC__
#    define GGML_ATTRIBUTE_FORMAT(...)
#elif defined(__MINGW32__) && !defined(__clang__)
#    define GGML_ATTRIBUTE_FORMAT(...) __attribute__((format(gnu_printf, __VA_ARGS__)))
#else
#    define GGML_ATTRIBUTE_FORMAT(...) __attribute__((format(printf, __VA_ARGS__)))
#endif

#if defined(_WIN32) && !defined(_WIN32_WINNT)
#    define _WIN32_WINNT 0x0A00
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define GGML_FILE_MAGIC   0x67676d6c // "ggml"
#define GGML_FILE_VERSION 2

#define GGML_QNT_VERSION        2    // bump this on quantization format changes
#define GGML_QNT_VERSION_FACTOR 1000 // do not change this

#define GGML_MAX_DIMS           4
#define GGML_MAX_PARAMS         2048
#define GGML_MAX_SRC            10
#define GGML_MAX_N_THREADS      512
#define GGML_MAX_OP_PARAMS      64

#ifndef GGML_MAX_NAME
#   define GGML_MAX_NAME        64
#endif

#define GGML_DEFAULT_N_THREADS  4
#define GGML_DEFAULT_GRAPH_SIZE 2048

#if UINTPTR_MAX == 0xFFFFFFFF
    #define GGML_MEM_ALIGN 4
#elif defined(__EMSCRIPTEN__)
// emscripten uses max_align_t == 8, so we need GGML_MEM_ALIGN == 8 for 64-bit wasm.
// (for 32-bit wasm, the first conditional is true and GGML_MEM_ALIGN stays 4.)
// ref: https://github.com/ggml-org/llama.cpp/pull/18628
    #define GGML_MEM_ALIGN 8
#else
    #define GGML_MEM_ALIGN 16
#endif

#define GGML_EXIT_SUCCESS 0
#define GGML_EXIT_ABORTED 1

// TODO: convert to enum https://github.com/ggml-org/llama.cpp/pull/16187#discussion_r2388538726
#define GGML_ROPE_TYPE_NORMAL 0
#define GGML_ROPE_TYPE_NEOX   2
#define GGML_ROPE_TYPE_MROPE  8
#define GGML_ROPE_TYPE_VISION 24
#define GGML_ROPE_TYPE_IMROPE 40 // binary: 101000

#define GGML_MROPE_SECTIONS   4

#define GGML_UNUSED(x) (void)(x)
#ifdef __CUDACC__
template<typename... Args>
__host__ __device__ constexpr inline void ggml_unused_vars_impl(Args&&...) noexcept {}
#define GGML_UNUSED_VARS(...) ggml_unused_vars_impl(__VA_ARGS__)
#else
#define GGML_UNUSED_VARS(...) do { (void)sizeof((__VA_ARGS__, 0)); } while(0)
#endif // __CUDACC__

#define GGML_PAD(x, n) (((x) + (n) - 1) & ~((n) - 1))

#ifndef NDEBUG
#   define GGML_UNREACHABLE() do { fprintf(stderr, "statement should be unreachable\n"); abort(); } while(0)
#elif defined(__GNUC__)
#   define GGML_UNREACHABLE() __builtin_unreachable()
#elif defined(_MSC_VER)
#   define GGML_UNREACHABLE() __assume(0)
#else
#   define GGML_UNREACHABLE() ((void) 0)
#endif

#ifdef __cplusplus
#   define GGML_NORETURN [[noreturn]]
#elif defined(_MSC_VER)
#   define GGML_NORETURN __declspec(noreturn)
#else
#   define GGML_NORETURN _Noreturn
#endif

#define GGML_ABORT(...) ggml_abort(__FILE__, __LINE__, __VA_ARGS__)
#define GGML_ASSERT(x) if (!(x)) GGML_ABORT("GGML_ASSERT(%s) failed", #x)

// used to copy the number of elements and stride in bytes of tensors into local variables.
// main purpose is to reduce code duplication and improve readability.
//
// example:
//
//    GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne);
//    GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb);
//
#define GGML_TENSOR_LOCALS_1(type, prefix, pointer, array) \
    const type prefix##0 = (pointer) ? (pointer)->array[0] : 0; \
    GGML_UNUSED(prefix##0);
#define GGML_TENSOR_LOCALS_2(type, prefix, pointer, array) \
    GGML_TENSOR_LOCALS_1    (type, prefix, pointer, array) \
    const type prefix##1 = (pointer) ? (pointer)->array[1] : 0; \
    GGML_UNUSED(prefix##1);
#define GGML_TENSOR_LOCALS_3(type, prefix, pointer, array) \
    GGML_TENSOR_LOCALS_2    (type, prefix, pointer, array) \
    const type prefix##2 = (pointer) ? (pointer)->array[2] : 0; \
    GGML_UNUSED(prefix##2);
#define GGML_TENSOR_LOCALS(type, prefix, pointer, array) \
    GGML_TENSOR_LOCALS_3  (type, prefix, pointer, array) \
    const type prefix##3 = (pointer) ? (pointer)->array[3] : 0; \
    GGML_UNUSED(prefix##3);

#define GGML_TENSOR_UNARY_OP_LOCALS \
    GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    GGML_TENSOR_LOCALS(int64_t, ne,  dst,  ne) \
    GGML_TENSOR_LOCALS(size_t,  nb,  dst,  nb)

#define GGML_TENSOR_BINARY_OP_LOCALS \
    GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb) \
    GGML_TENSOR_LOCALS(int64_t, ne,  dst,  ne) \
    GGML_TENSOR_LOCALS(size_t,  nb,  dst,  nb)

#define GGML_TENSOR_TERNARY_OP_LOCALS \
    GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb) \
    GGML_TENSOR_LOCALS(int64_t, ne2, src2, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb2, src2, nb) \
    GGML_TENSOR_LOCALS(int64_t, ne,  dst,  ne) \
    GGML_TENSOR_LOCALS(size_t,  nb,  dst,  nb)

#define GGML_TENSOR_BINARY_OP_LOCALS01 \
    GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne) \
    GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb)

#ifdef  __cplusplus
extern "C" {
#endif

    // Function type used in fatal error callbacks
    typedef void (*ggml_abort_callback_t)(const char * error_message);

    // Set the abort callback (passing null will restore original abort functionality: printing a message to stdout)
    // Returns the old callback for chaining
    GGML_API ggml_abort_callback_t ggml_set_abort_callback(ggml_abort_callback_t callback);

    GGML_NORETURN GGML_ATTRIBUTE_FORMAT(3, 4)
    GGML_API void ggml_abort(const char * file, int line, const char * fmt, ...);

    enum ggml_status {
        GGML_STATUS_ALLOC_FAILED = -2,
        GGML_STATUS_FAILED = -1,
        GGML_STATUS_SUCCESS = 0,
        GGML_STATUS_ABORTED = 1,
    };

    // get ggml_status name string
    GGML_API const char * ggml_status_to_string(enum ggml_status status);

    // ieee 754-2008 half-precision float16
    // todo: make this not an integral type
    typedef uint16_t ggml_fp16_t;
    GGML_API float       ggml_fp16_to_fp32(ggml_fp16_t);
    GGML_API ggml_fp16_t ggml_fp32_to_fp16(float);
    GGML_API void        ggml_fp16_to_fp32_row(const ggml_fp16_t *, float *, int64_t);
    GGML_API void        ggml_fp32_to_fp16_row(const float *, ggml_fp16_t *, int64_t);

    // google brain half-precision bfloat16
    typedef struct { uint16_t bits; } ggml_bf16_t;
    GGML_API ggml_bf16_t ggml_fp32_to_bf16(float);
    GGML_API float       ggml_bf16_to_fp32(ggml_bf16_t);  // consider just doing << 16
    GGML_API void        ggml_bf16_to_fp32_row(const ggml_bf16_t *, float *, int64_t);
    GGML_API void        ggml_fp32_to_bf16_row_ref(const float *, ggml_bf16_t *, int64_t);
    GGML_API void        ggml_fp32_to_bf16_row(const float *, ggml_bf16_t *, int64_t);

    struct ggml_object;
    struct ggml_context;
    struct ggml_cgraph;

    // NOTE: always add types at the end of the enum to keep backward compatibility
    enum ggml_type {
        GGML_TYPE_F32     = 0,
        GGML_TYPE_F16     = 1,
        GGML_TYPE_Q4_0    = 2,
        GGML_TYPE_Q4_1    = 3,
        // GGML_TYPE_Q4_2 = 4, support has been removed
        // GGML_TYPE_Q4_3 = 5, support has been removed
        GGML_TYPE_Q5_0    = 6,
        GGML_TYPE_Q5_1    = 7,
        GGML_TYPE_Q8_0    = 8,
        GGML_TYPE_Q8_1    = 9,
        GGML_TYPE_Q2_K    = 10,
        GGML_TYPE_Q3_K    = 11,
        GGML_TYPE_Q4_K    = 12,
        GGML_TYPE_Q5_K    = 13,
        GGML_TYPE_Q6_K    = 14,
        GGML_TYPE_Q8_K    = 15,
        GGML_TYPE_IQ2_XXS = 16,
        GGML_TYPE_IQ2_XS  = 17,
        GGML_TYPE_IQ3_XXS = 18,
        GGML_TYPE_IQ1_S   = 19,
        GGML_TYPE_IQ4_NL  = 20,
        GGML_TYPE_IQ3_S   = 21,
        GGML_TYPE_IQ2_S   = 22,
        GGML_TYPE_IQ4_XS  = 23,
        GGML_TYPE_I8      = 24,
        GGML_TYPE_I16     = 25,
        GGML_TYPE_I32     = 26,
        GGML_TYPE_I64     = 27,
        GGML_TYPE_F64     = 28,
        GGML_TYPE_IQ1_M   = 29,
        GGML_TYPE_BF16    = 30,
        // GGML_TYPE_Q4_0_4_4 = 31, support has been removed from gguf files
        // GGML_TYPE_Q4_0_4_8 = 32,
        // GGML_TYPE_Q4_0_8_8 = 33,
        GGML_TYPE_TQ1_0   = 34,
        GGML_TYPE_TQ2_0   = 35,
        // GGML_TYPE_IQ4_NL_4_4 = 36,
        // GGML_TYPE_IQ4_NL_4_8 = 37,
        // GGML_TYPE_IQ4_NL_8_8 = 38,
        GGML_TYPE_MXFP4   = 39, // MXFP4 (1 block)
        GGML_TYPE_NVFP4   = 40, // NVFP4 (4 blocks, E4M3 scale)
        GGML_TYPE_COUNT   = 41,
    };

    // precision
    enum ggml_prec {
        GGML_PREC_DEFAULT =  0, // stored as ggml_tensor.op_params, 0 by default
        GGML_PREC_F32     = 10,
    };

    // model file types
    enum ggml_ftype {
        GGML_FTYPE_UNKNOWN        = -1,
        GGML_FTYPE_ALL_F32        = 0,
        GGML_FTYPE_MOSTLY_F16     = 1,  // except 1d tensors
        GGML_FTYPE_MOSTLY_Q4_0    = 2,  // except 1d tensors
        GGML_FTYPE_MOSTLY_Q4_1    = 3,  // except 1d tensors
        GGML_FTYPE_MOSTLY_Q4_1_SOME_F16 = 4, // tok_embeddings.weight and output.weight are F16
        GGML_FTYPE_MOSTLY_Q8_0    = 7,  // except 1d tensors
        GGML_FTYPE_MOSTLY_Q5_0    = 8,  // except 1d tensors
        GGML_FTYPE_MOSTLY_Q5_1    = 9,  // except 1d tensors
        GGML_FTYPE_MOSTLY_Q2_K    = 10, // except 1d tensors
        GGML_FTYPE_MOSTLY_Q3_K    = 11, // except 1d tensors
        GGML_FTYPE_MOSTLY_Q4_K    = 12, // except 1d tensors
        GGML_FTYPE_MOSTLY_Q5_K    = 13, // except 1d tensors
        GGML_FTYPE_MOSTLY_Q6_K    = 14, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ2_XXS = 15, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ2_XS  = 16, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ3_XXS = 17, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ1_S   = 18, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ4_NL  = 19, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ3_S   = 20, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ2_S   = 21, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ4_XS  = 22, // except 1d tensors
        GGML_FTYPE_MOSTLY_IQ1_M   = 23, // except 1d tensors
        GGML_FTYPE_MOSTLY_BF16    = 24, // except 1d tensors
        GGML_FTYPE_MOSTLY_MXFP4   = 25, // except 1d tensors
        GGML_FTYPE_MOSTLY_NVFP4   = 26, // except 1d tensors
    };

    // available tensor operations:
    enum ggml_op {
        GGML_OP_NONE = 0,

        GGML_OP_DUP,
        GGML_OP_ADD,
        GGML_OP_ADD_ID,
        GGML_OP_ADD1,
        GGML_OP_ACC,
        GGML_OP_SUB,
        GGML_OP_MUL,
        GGML_OP_DIV,
        GGML_OP_SQR,
        GGML_OP_SQRT,
        GGML_OP_LOG,
        GGML_OP_SIN,
        GGML_OP_COS,
        GGML_OP_SUM,
        GGML_OP_SUM_ROWS,
        GGML_OP_CUMSUM,
        GGML_OP_MEAN,
        GGML_OP_ARGMAX,
        GGML_OP_COUNT_EQUAL,
        GGML_OP_REPEAT,
        GGML_OP_REPEAT_BACK,
        GGML_OP_CONCAT,
        GGML_OP_SILU_BACK,
        GGML_OP_NORM, // normalize
        GGML_OP_RMS_NORM,
        GGML_OP_RMS_NORM_BACK,
        GGML_OP_GROUP_NORM,
        GGML_OP_L2_NORM,

        GGML_OP_MUL_MAT,
        GGML_OP_MUL_MAT_ID,
        GGML_OP_OUT_PROD,

        GGML_OP_SCALE,
        GGML_OP_SET,
        GGML_OP_CPY,
        GGML_OP_CONT,
        GGML_OP_RESHAPE,
        GGML_OP_VIEW,
        GGML_OP_PERMUTE,
        GGML_OP_TRANSPOSE,
        GGML_OP_GET_ROWS,
        GGML_OP_GET_ROWS_BACK,
        GGML_OP_SET_ROWS,
        GGML_OP_DIAG,
        GGML_OP_DIAG_MASK_INF,
        GGML_OP_DIAG_MASK_ZERO,
        GGML_OP_SOFT_MAX,
        GGML_OP_SOFT_MAX_BACK,
        GGML_OP_ROPE,
        GGML_OP_ROPE_BACK,
        GGML_OP_CLAMP,
        GGML_OP_CONV_TRANSPOSE_1D,
        GGML_OP_IM2COL,
        GGML_OP_IM2COL_BACK,
        GGML_OP_IM2COL_3D,
        GGML_OP_CONV_2D,
        GGML_OP_CONV_3D,
        GGML_OP_CONV_2D_DW,
        GGML_OP_CONV_TRANSPOSE_2D,
        GGML_OP_POOL_1D,
        GGML_OP_POOL_2D,
        GGML_OP_POOL_2D_BACK,
        GGML_OP_UPSCALE,
        GGML_OP_PAD,
        GGML_OP_PAD_REFLECT_1D,
        GGML_OP_ROLL,
        GGML_OP_ARANGE,
        GGML_OP_TIMESTEP_EMBEDDING,
        GGML_OP_ARGSORT,
        GGML_OP_TOP_K,
        GGML_OP_LEAKY_RELU,
        GGML_OP_TRI,
        GGML_OP_FILL,

        GGML_OP_FLASH_ATTN_EXT,
        GGML_OP_FLASH_ATTN_BACK,
        GGML_OP_SSM_CONV,
        GGML_OP_SSM_SCAN,
        GGML_OP_WIN_PART,
        GGML_OP_WIN_UNPART,
        GGML_OP_GET_REL_POS,
        GGML_OP_ADD_REL_POS,
        GGML_OP_RWKV_WKV6,
        GGML_OP_GATED_LINEAR_ATTN,
        GGML_OP_RWKV_WKV7,
        GGML_OP_SOLVE_TRI,
        GGML_OP_GATED_DELTA_NET,

        GGML_OP_UNARY,

        GGML_OP_MAP_CUSTOM1,
        GGML_OP_MAP_CUSTOM2,
        GGML_OP_MAP_CUSTOM3,

        GGML_OP_CUSTOM,

        GGML_OP_CROSS_ENTROPY_LOSS,
        GGML_OP_CROSS_ENTROPY_LOSS_BACK,
        GGML_OP_OPT_STEP_ADAMW,
        GGML_OP_OPT_STEP_SGD,

        GGML_OP_GLU,

        GGML_OP_COUNT,
    };

    enum ggml_unary_op {
        GGML_UNARY_OP_ABS,
        GGML_UNARY_OP_SGN,
        GGML_UNARY_OP_NEG,
        GGML_UNARY_OP_STEP,
        GGML_UNARY_OP_TANH,
        GGML_UNARY_OP_ELU,
        GGML_UNARY_OP_RELU,
        GGML_UNARY_OP_SIGMOID,
        GGML_UNARY_OP_GELU,
        GGML_UNARY_OP_GELU_QUICK,
        GGML_UNARY_OP_SILU,
        GGML_UNARY_OP_HARDSWISH,
        GGML_UNARY_OP_HARDSIGMOID,
        GGML_UNARY_OP_EXP,
        GGML_UNARY_OP_EXPM1,
        GGML_UNARY_OP_SOFTPLUS,
        GGML_UNARY_OP_GELU_ERF,
        GGML_UNARY_OP_XIELU,
        GGML_UNARY_OP_FLOOR,
        GGML_UNARY_OP_CEIL,
        GGML_UNARY_OP_ROUND,
        GGML_UNARY_OP_TRUNC,

        GGML_UNARY_OP_COUNT,
    };

    enum ggml_glu_op {
        GGML_GLU_OP_REGLU,
        GGML_GLU_OP_GEGLU,
        GGML_GLU_OP_SWIGLU,
        GGML_GLU_OP_SWIGLU_OAI,
        GGML_GLU_OP_GEGLU_ERF,
        GGML_GLU_OP_GEGLU_QUICK,

        GGML_GLU_OP_COUNT,
    };

    enum ggml_object_type {
        GGML_OBJECT_TYPE_TENSOR,
        GGML_OBJECT_TYPE_GRAPH,
        GGML_OBJECT_TYPE_WORK_BUFFER
    };

    enum ggml_log_level {
        GGML_LOG_LEVEL_NONE  = 0,
        GGML_LOG_LEVEL_DEBUG = 1,
        GGML_LOG_LEVEL_INFO  = 2,
        GGML_LOG_LEVEL_WARN  = 3,
        GGML_LOG_LEVEL_ERROR = 4,
        GGML_LOG_LEVEL_CONT  = 5, // continue previous log
    };

    // this tensor...
    enum ggml_tensor_flag {
        GGML_TENSOR_FLAG_INPUT   =  1, // ...is an input for the GGML compute graph
        GGML_TENSOR_FLAG_OUTPUT  =  2, // ...is an output for the GGML compute graph
        GGML_TENSOR_FLAG_PARAM   =  4, // ...contains trainable parameters
        GGML_TENSOR_FLAG_LOSS    =  8, // ...defines loss for numerical optimization (multiple loss tensors add up)
        GGML_TENSOR_FLAG_COMPUTE = 16, // ...must be computed
    };

    enum ggml_tri_type {
        GGML_TRI_TYPE_UPPER_DIAG = 0,
        GGML_TRI_TYPE_UPPER      = 1,
        GGML_TRI_TYPE_LOWER_DIAG = 2,
        GGML_TRI_TYPE_LOWER      = 3
    };

    struct ggml_init_params {
        // memory pool
        size_t mem_size;   // bytes
        void * mem_buffer; // if NULL, memory will be allocated internally
        bool   no_alloc;   // don't allocate memory for the tensor data
    };

    // n-dimensional tensor
    struct ggml_tensor {
        enum ggml_type type;

        struct ggml_backend_buffer * buffer;

        int64_t ne[GGML_MAX_DIMS]; // number of elements
        size_t  nb[GGML_MAX_DIMS]; // stride in bytes:
                                   // nb[0] = ggml_type_size(type)
                                   // nb[1] = nb[0]   * (ne[0] / ggml_blck_size(type)) + padding
                                   // nb[i] = nb[i-1] * ne[i-1]

        // compute data
        enum ggml_op op;

        // op params - allocated as int32_t for alignment
        int32_t op_params[GGML_MAX_OP_PARAMS / sizeof(int32_t)];

        int32_t flags;

        struct ggml_tensor * src[GGML_MAX_SRC];

        // source tensor and offset for views
        struct ggml_tensor * view_src;
        size_t               view_offs;

        void * data;

        char name[GGML_MAX_NAME];

        void * extra; // extra things e.g. for ggml-cuda.cu

        char padding[8];
    };

    static const size_t GGML_TENSOR_SIZE = sizeof(struct ggml_tensor);

    // Abort callback
    // If not NULL, called before ggml computation
    // If it returns true, the computation is aborted
    typedef bool (*ggml_abort_callback)(void * data);


    //
    // GUID
    //

    // GUID types
    typedef uint8_t ggml_guid[16];
    typedef ggml_guid * ggml_guid_t;

    GGML_API bool ggml_guid_matches(ggml_guid_t guid_a, ggml_guid_t guid_b);

    // misc

    GGML_API const char * ggml_version(void);
    GGML_API const char * ggml_commit(void);

    GGML_API void    ggml_time_init(void); // call this once at the beginning of the program
    GGML_API int64_t ggml_time_ms(void);
    GGML_API int64_t ggml_time_us(void);
    GGML_API int64_t ggml_cycles(void);
    GGML_API int64_t ggml_cycles_per_ms(void);

    // accepts a UTF-8 path, even on Windows
    GGML_API FILE *  ggml_fopen(const char * fname, const char * mode);

    GGML_API void    ggml_print_object (const struct ggml_object * obj);
    GGML_API void    ggml_print_objects(const struct ggml_context * ctx);

    GGML_API int64_t ggml_nelements (const struct ggml_tensor * tensor);
    GGML_API int64_t ggml_nrows     (const struct ggml_tensor * tensor);
    GGML_API size_t  ggml_nbytes    (const struct ggml_tensor * tensor);
    GGML_API size_t  ggml_nbytes_pad(const struct ggml_tensor * tensor); // same as ggml_nbytes() but padded to GGML_MEM_ALIGN

    GGML_API int64_t ggml_blck_size(enum ggml_type type);
    GGML_API size_t  ggml_type_size(enum ggml_type type);             // size in bytes for all elements in a block
    GGML_API size_t  ggml_row_size (enum ggml_type type, int64_t ne); // size in bytes for all elements in a row

    GGML_DEPRECATED(
    GGML_API double ggml_type_sizef(enum ggml_type type), // ggml_type_size()/ggml_blck_size() as float
    "use ggml_row_size() instead");

    GGML_API const char * ggml_type_name(enum ggml_type type);
    GGML_API const char * ggml_op_name  (enum ggml_op   op);
    GGML_API const char * ggml_op_symbol(enum ggml_op   op);

    GGML_API const char * ggml_unary_op_name(enum ggml_unary_op op);
    GGML_API const char * ggml_glu_op_name(enum ggml_glu_op op);
    GGML_API const char * ggml_op_desc(const struct ggml_tensor * t); // unary or op name

    GGML_API size_t  ggml_element_size(const struct ggml_tensor * tensor);

    GGML_API bool    ggml_is_quantized(enum ggml_type type);

    // TODO: temporary until model loading of ggml examples is refactored
    GGML_API enum ggml_type ggml_ftype_to_ggml_type(enum ggml_ftype ftype);

    GGML_API bool ggml_is_transposed(const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_permuted  (const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_empty     (const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_view      (const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_scalar    (const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_vector    (const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_matrix    (const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_3d        (const struct ggml_tensor * tensor);
    GGML_API int  ggml_n_dims       (const struct ggml_tensor * tensor); // returns 1 for scalars

    // returns whether the tensor elements can be iterated over with a flattened index (no gaps, no permutation)
    GGML_API bool ggml_is_contiguous  (const struct ggml_tensor * tensor);
    GGML_API bool ggml_is_contiguous_0(const struct ggml_tensor * tensor); // same as ggml_is_contiguous()
    GGML_API bool ggml_is_contiguous_1(const struct ggml_tensor * tensor); // contiguous for dims >= 1
    GGML_API bool ggml_is_contiguous_2(const struct ggml_tensor * tensor); // contiguous for dims >= 2

    // returns whether the tensor elements are allocated as one contiguous block of memory (no gaps, but permutation ok)
    GGML_API bool ggml_is_contiguously_allocated(const struct ggml_tensor * tensor);

    // true for tensor that is stored in memory as CxWxHxN and has been permuted to WxHxCxN
    GGML_API bool ggml_is_contiguous_channels(const struct ggml_tensor * tensor);

    // true if the elements in dimension 0 are contiguous, or there is just 1 block of elements
    GGML_API bool ggml_is_contiguous_rows(const struct ggml_tensor * tensor);

    GGML_API bool ggml_are_same_shape (const struct ggml_tensor * t0, const struct ggml_tensor * t1);
    GGML_API bool ggml_are_same_stride(const struct ggml_tensor * t0, const struct ggml_tensor * t1);

    GGML_API bool ggml_can_repeat(const struct ggml_tensor * t0, const struct ggml_tensor * t1);

    // use this to compute the memory overhead of a tensor
    GGML_API size_t ggml_tensor_overhead(void);

    GGML_API bool ggml_validate_row_data(enum ggml_type type, const void * data, size_t nbytes);

    // main

    GGML_API struct ggml_context * ggml_init (struct ggml_init_params params);
    GGML_API void                  ggml_reset(struct ggml_context * ctx);
    GGML_API void                  ggml_free (struct ggml_context * ctx);

    GGML_API size_t  ggml_used_mem(const struct ggml_context * ctx);

    GGML_API bool    ggml_get_no_alloc(struct ggml_context * ctx);
    GGML_API void    ggml_set_no_alloc(struct ggml_context * ctx, bool no_alloc);

    GGML_API void *  ggml_get_mem_buffer     (const struct ggml_context * ctx);
    GGML_API size_t  ggml_get_mem_size       (const struct ggml_context * ctx);
    GGML_API size_t  ggml_get_max_tensor_size(const struct ggml_context * ctx);

    GGML_API struct ggml_tensor * ggml_new_tensor(
            struct ggml_context * ctx,
            enum   ggml_type type,
            int    n_dims,
            const int64_t *ne);

    GGML_API struct ggml_tensor * ggml_new_tensor_1d(
            struct ggml_context * ctx,
            enum   ggml_type type,
            int64_t ne0);

    GGML_API struct ggml_tensor * ggml_new_tensor_2d(
            struct ggml_context * ctx,
            enum   ggml_type type,
            int64_t ne0,
            int64_t ne1);

    GGML_API struct ggml_tensor * ggml_new_tensor_3d(
            struct ggml_context * ctx,
            enum   ggml_type type,
            int64_t ne0,
            int64_t ne1,
            int64_t ne2);

    GGML_API struct ggml_tensor * ggml_new_tensor_4d(
            struct ggml_context * ctx,
            enum   ggml_type type,
            int64_t ne0,
            int64_t ne1,
            int64_t ne2,
            int64_t ne3);

    GGML_API void * ggml_new_buffer(struct ggml_context * ctx, size_t nbytes);

    GGML_API struct ggml_tensor * ggml_dup_tensor (struct ggml_context * ctx, const struct ggml_tensor * src);
    GGML_API struct ggml_tensor * ggml_view_tensor(struct ggml_context * ctx, struct ggml_tensor * src);

    // Context tensor enumeration and lookup
    GGML_API struct ggml_tensor * ggml_get_first_tensor(const struct ggml_context * ctx);
    GGML_API struct ggml_tensor * ggml_get_next_tensor (const struct ggml_context * ctx, struct ggml_tensor * tensor);
    GGML_API struct ggml_tensor * ggml_get_tensor(struct ggml_context * ctx, const char * name);

    // Converts a flat index into coordinates
    GGML_API void ggml_unravel_index(const struct ggml_tensor * tensor, int64_t i, int64_t * i0, int64_t * i1, int64_t * i2, int64_t * i3);

    GGML_API enum ggml_unary_op ggml_get_unary_op(const struct ggml_tensor * tensor);
    GGML_API enum ggml_glu_op ggml_get_glu_op(const struct ggml_tensor * tensor);

    GGML_API void *  ggml_get_data    (const struct ggml_tensor * tensor);
    GGML_API float * ggml_get_data_f32(const struct ggml_tensor * tensor);

    GGML_API const char *         ggml_get_name   (const struct ggml_tensor * tensor);
    GGML_API struct ggml_tensor * ggml_set_name   (      struct ggml_tensor * tensor, const char * name);
    GGML_ATTRIBUTE_FORMAT(2, 3)
    GGML_API struct ggml_tensor * ggml_format_name(      struct ggml_tensor * tensor, const char * fmt, ...);

    // Tensor flags
    GGML_API void ggml_set_input(struct ggml_tensor * tensor);
    GGML_API void ggml_set_output(struct ggml_tensor * tensor);
    GGML_API void ggml_set_param(struct ggml_tensor * tensor);
    GGML_API void ggml_set_loss(struct ggml_tensor * tensor);

    //
    // operations on tensors with backpropagation
    //

    GGML_API struct ggml_tensor * ggml_dup(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_dup_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_add(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_add_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_add_cast(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            enum   ggml_type      type);

    // dst[i0, i1, i2] = a[i0, i1, i2] + b[i0, ids[i1, i2]]
    GGML_API struct ggml_tensor * ggml_add_id(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            struct ggml_tensor  * ids);

    GGML_API struct ggml_tensor * ggml_add1(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_add1_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // dst = a
    // view(dst, nb1, nb2, nb3, offset) += b
    // return dst
    GGML_API struct ggml_tensor * ggml_acc(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset);

    GGML_API struct ggml_tensor * ggml_acc_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset);

    GGML_API struct ggml_tensor * ggml_sub(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_sub_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_mul(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_mul_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_div(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_div_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_sqr(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sqr_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sqrt(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sqrt_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_log(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_log_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_expm1(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_expm1_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_softplus(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_softplus_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sin(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sin_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_cos(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_cos_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // return scalar
    GGML_API struct ggml_tensor * ggml_sum(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // sums along rows, with input shape [a,b,c,d] return shape [1,b,c,d]
    GGML_API struct ggml_tensor * ggml_sum_rows(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_cumsum(
        struct ggml_context * ctx,
        struct ggml_tensor  * a);

    // mean along rows
    GGML_API struct ggml_tensor * ggml_mean(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // argmax along rows
    GGML_API struct ggml_tensor * ggml_argmax(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // count number of equal elements in a and b
    GGML_API struct ggml_tensor * ggml_count_equal(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // if a is the same shape as b, and a is not parameter, return a
    // otherwise, return a new tensor: repeat(a) to fit in b
    GGML_API struct ggml_tensor * ggml_repeat(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // repeat a to the specified shape
    GGML_API struct ggml_tensor * ggml_repeat_4d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
                       int64_t    ne0,
                       int64_t    ne1,
                       int64_t    ne2,
                       int64_t    ne3);

    // sums repetitions in a into shape of b
    GGML_API struct ggml_tensor * ggml_repeat_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b); // sum up values that are adjacent in dims > 0 instead of repeated with same stride

    // concat a and b along dim
    // used in stable-diffusion
    GGML_API struct ggml_tensor * ggml_concat(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int                   dim);

    GGML_API struct ggml_tensor * ggml_abs(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_abs_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sgn(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sgn_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_neg(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_neg_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_step(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_step_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_tanh(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_tanh_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_elu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_elu_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_relu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_leaky_relu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a, float negative_slope, bool inplace);

    GGML_API struct ggml_tensor * ggml_relu_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sigmoid(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_sigmoid_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_gelu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_gelu_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // GELU using erf (error function) when possible
    // some backends may fallback to approximation based on Abramowitz and Stegun formula
    GGML_API struct ggml_tensor * ggml_gelu_erf(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_gelu_erf_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_gelu_quick(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_gelu_quick_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_silu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_silu_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // a - x
    // b - dy
    GGML_API struct ggml_tensor * ggml_silu_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // hardswish(x) = x * relu6(x + 3) / 6
    GGML_API struct ggml_tensor * ggml_hardswish(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // hardsigmoid(x) = relu6(x + 3) / 6
    GGML_API struct ggml_tensor * ggml_hardsigmoid(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_exp(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_exp_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_floor(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_floor_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_ceil(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_ceil_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_round(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_round_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

     /**
     * Truncates the fractional part of each element in the tensor (towards zero).
     * For example: trunc(3.7) = 3.0, trunc(-2.9) = -2.0
     * Similar to std::trunc in C/C++.
     */

    GGML_API struct ggml_tensor * ggml_trunc(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_trunc_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);



    // xIELU activation function
    // x = x * (c_a(alpha_n) + c_b(alpha_p, beta) * sigmoid(beta * x)) + eps * (x > 0)
    // where c_a = softplus and c_b(a, b) = softplus(a) + b are constraining functions
    // that constrain the positive and negative source alpha values respectively
    GGML_API struct ggml_tensor * ggml_xielu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float alpha_n,
            float alpha_p,
            float beta,
            float eps);

    // gated linear unit ops
    // A: n columns, r rows,
    // result is n / 2 columns, r rows,
    // expects gate in second half of row, unless swapped is true
    GGML_API struct ggml_tensor * ggml_glu(
            struct ggml_context * ctx,
             struct ggml_tensor * a,
             enum ggml_glu_op     op,
             bool                 swapped);

    GGML_API struct ggml_tensor * ggml_reglu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_reglu_swapped(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_geglu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_geglu_swapped(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_swiglu(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_swiglu_swapped(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_geglu_erf(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_geglu_erf_swapped(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_geglu_quick(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    GGML_API struct ggml_tensor * ggml_geglu_quick_swapped(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // A: n columns, r rows,
    // B: n columns, r rows,
    GGML_API struct ggml_tensor * ggml_glu_split(
            struct ggml_context * ctx,
             struct ggml_tensor * a,
             struct ggml_tensor * b,
             enum ggml_glu_op     op);

    GGML_API struct ggml_tensor * ggml_reglu_split(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_geglu_split(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_swiglu_split(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_geglu_erf_split(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_geglu_quick_split(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    GGML_API struct ggml_tensor * ggml_swiglu_oai(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            float                 alpha,
            float                 limit);

    // normalize along rows
    GGML_API struct ggml_tensor * ggml_norm(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 eps);

    GGML_API struct ggml_tensor * ggml_norm_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 eps);

    GGML_API struct ggml_tensor * ggml_rms_norm(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 eps);

    GGML_API struct ggml_tensor * ggml_rms_norm_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 eps);

    // group normalize along ne0*ne1*n_groups
    // used in stable-diffusion
    GGML_API struct ggml_tensor * ggml_group_norm(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   n_groups,
            float                 eps);

    GGML_API struct ggml_tensor * ggml_group_norm_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   n_groups,
            float                 eps);

    // l2 normalize along rows
    // used in rwkv v7
    GGML_API struct ggml_tensor * ggml_l2_norm(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 eps);

    GGML_API struct ggml_tensor * ggml_l2_norm_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 eps);

    // a - x
    // b - dy
    GGML_API struct ggml_tensor * ggml_rms_norm_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            float                 eps);

    // A: k columns, n rows => [ne03, ne02, n, k]
    // B: k columns, m rows  (i.e. we transpose it internally) => [ne03 * x, ne02 * y, m, k]
    // result is n columns, m rows => [ne03 * x, ne02 * y, m, n]
    GGML_API struct ggml_tensor * ggml_mul_mat(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // change the precision of a matrix multiplication
    // set to GGML_PREC_F32 for higher precision (useful for phi-2)
    GGML_API void ggml_mul_mat_set_prec(
            struct ggml_tensor * a,
            enum ggml_prec       prec);

    // indirect matrix multiplication
    GGML_API struct ggml_tensor * ggml_mul_mat_id(
            struct ggml_context * ctx,
            struct ggml_tensor  * as,
            struct ggml_tensor  * b,
            struct ggml_tensor  * ids);

    // A: m columns, n rows,
    // B: p columns, n rows,
    // result is m columns, p rows
    GGML_API struct ggml_tensor * ggml_out_prod(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    //
    // operations on tensors without backpropagation
    //

    GGML_API struct ggml_tensor * ggml_scale(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 s);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_scale_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 s);

    // x = s * a + b
    GGML_API struct ggml_tensor * ggml_scale_bias(
        struct ggml_context * ctx,
        struct ggml_tensor  * a,
        float                 s,
        float                 b);

    GGML_API struct ggml_tensor * ggml_scale_bias_inplace(
        struct ggml_context * ctx,
        struct ggml_tensor  * a,
        float                 s,
        float                 b);

    // b -> view(a,offset,nb1,nb2,3), return modified a
    GGML_API struct ggml_tensor * ggml_set(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset); // in bytes

    // b -> view(a,offset,nb1,nb2,3), return view(a)
    GGML_API struct ggml_tensor * ggml_set_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset); // in bytes

    GGML_API struct ggml_tensor * ggml_set_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                offset); // in bytes

    GGML_API struct ggml_tensor * ggml_set_1d_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                offset); // in bytes

    // b -> view(a,offset,nb1,nb2,3), return modified a
    GGML_API struct ggml_tensor * ggml_set_2d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                nb1,
            size_t                offset); // in bytes

    // b -> view(a,offset,nb1,nb2,3), return view(a)
    GGML_API struct ggml_tensor * ggml_set_2d_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            size_t                nb1,
            size_t                offset); // in bytes

    // a -> b, return view(b)
    GGML_API struct ggml_tensor * ggml_cpy(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // note: casting from f32 to i32 will discard the fractional part
    GGML_API struct ggml_tensor * ggml_cast(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            enum   ggml_type      type);

    // make contiguous
    GGML_API struct ggml_tensor * ggml_cont(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // make contiguous, with new shape
    GGML_API struct ggml_tensor * ggml_cont_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0);

    GGML_API struct ggml_tensor * ggml_cont_2d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1);

    GGML_API struct ggml_tensor * ggml_cont_3d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2);

    GGML_API struct ggml_tensor * ggml_cont_4d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3);

    // return view(a), b specifies the new shape
    // TODO: when we start computing gradient, make a copy instead of view
    GGML_API struct ggml_tensor * ggml_reshape(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // return view(a)
    // TODO: when we start computing gradient, make a copy instead of view
    GGML_API struct ggml_tensor * ggml_reshape_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0);

    GGML_API struct ggml_tensor * ggml_reshape_2d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1);

    // return view(a)
    // TODO: when we start computing gradient, make a copy instead of view
    GGML_API struct ggml_tensor * ggml_reshape_3d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2);

    GGML_API struct ggml_tensor * ggml_reshape_4d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3);

    // offset in bytes
    GGML_API struct ggml_tensor * ggml_view_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            size_t                offset);

    GGML_API struct ggml_tensor * ggml_view_2d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            size_t                nb1, // row stride in bytes
            size_t                offset);

    GGML_API struct ggml_tensor * ggml_view_3d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            size_t                nb1, // row   stride in bytes
            size_t                nb2, // slice stride in bytes
            size_t                offset);

    GGML_API struct ggml_tensor * ggml_view_4d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3,
            size_t                nb1, // row   stride in bytes
            size_t                nb2, // slice stride in bytes
            size_t                nb3,
            size_t                offset);

    GGML_API struct ggml_tensor * ggml_permute(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   axis0,
            int                   axis1,
            int                   axis2,
            int                   axis3);

    // alias for ggml_permute(ctx, a, 1, 0, 2, 3)
    GGML_API struct ggml_tensor * ggml_transpose(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // supports 4D a:
    // a     [n_embd, ne1, ne2, ne3]
    // b I32 [n_rows, ne2, ne3, 1]
    //
    // return [n_embd, n_rows, ne2, ne3]
    GGML_API struct ggml_tensor * ggml_get_rows(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // data
            struct ggml_tensor  * b); // row indices

    GGML_API struct ggml_tensor * ggml_get_rows_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // gradients of ggml_get_rows result
            struct ggml_tensor  * b,  // row indices
            struct ggml_tensor  * c); // data for ggml_get_rows, only used for its shape

    // a TD  [n_embd, ne1,    ne2,    ne3]
    // b TS  [n_embd, n_rows, ne02,   ne03] | ne02 == ne2, ne03 == ne3
    // c I64 [n_rows, ne11,   ne12,   1]    | c[i] in [0, ne1)
    //
    // undefined behavior if destination rows overlap
    //
    // broadcast:
    //   ne2 % ne11 == 0
    //   ne3 % ne12 == 0
    //
    // return view(a)
    GGML_API struct ggml_tensor * ggml_set_rows(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // destination
            struct ggml_tensor  * b,  // source
            struct ggml_tensor  * c); // row indices

    GGML_API struct ggml_tensor * ggml_diag(
        struct ggml_context     * ctx,
        struct ggml_tensor      * a);

    // set elements above the diagonal to -INF
    GGML_API struct ggml_tensor * ggml_diag_mask_inf(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   n_past);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_diag_mask_inf_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   n_past);

    // set elements above the diagonal to 0
    GGML_API struct ggml_tensor * ggml_diag_mask_zero(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   n_past);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_diag_mask_zero_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   n_past);

    GGML_API struct ggml_tensor * ggml_soft_max(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_soft_max_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a);

    // a    [ne0, ne01, ne02, ne03]
    // mask [ne0, ne11, ne12, ne13] | ne11 >= ne01, F16 or F32, optional
    //
    // broadcast:
    //   ne02 % ne12 == 0
    //   ne03 % ne13 == 0
    //
    // fused soft_max(a*scale + mask*(ALiBi slope))
    // max_bias = 0.0f for no ALiBi
    GGML_API struct ggml_tensor * ggml_soft_max_ext(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * mask,
            float                 scale,
            float                 max_bias);

    GGML_API struct ggml_tensor * ggml_soft_max_ext_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * mask,
            float                 scale,
            float                 max_bias);

    GGML_API void ggml_soft_max_add_sinks(
            struct ggml_tensor * a,
            struct ggml_tensor * sinks);

    GGML_API struct ggml_tensor * ggml_soft_max_ext_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            float                 scale,
            float                 max_bias);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_soft_max_ext_back_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            float                 scale,
            float                 max_bias);

    // rotary position embedding
    // if (mode & 1) - skip n_past elements (NOT SUPPORTED)
    // if (mode & GGML_ROPE_TYPE_NEOX) - GPT-NeoX style
    //
    // b is an int32 vector with size a->ne[2], it contains the positions
    GGML_API struct ggml_tensor * ggml_rope(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int                   n_dims,
            int                   mode);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_rope_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int                   n_dims,
            int                   mode);

    // custom RoPE
    // c is freq factors (e.g. phi3-128k), (optional)
    GGML_API struct ggml_tensor * ggml_rope_ext(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            struct ggml_tensor  * c,
            int                   n_dims,
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow);

    GGML_API struct ggml_tensor * ggml_rope_multi(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            struct ggml_tensor  * c,
            int                   n_dims,
            int                   sections[GGML_MROPE_SECTIONS],
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow);

    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_rope_ext_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            struct ggml_tensor  * c,
            int                   n_dims,
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow);

    GGML_API struct ggml_tensor * ggml_rope_multi_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            struct ggml_tensor  * c,
            int                   n_dims,
            int                   sections[GGML_MROPE_SECTIONS],
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow);

    GGML_DEPRECATED(GGML_API struct ggml_tensor * ggml_rope_custom(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int                   n_dims,
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow),
        "use ggml_rope_ext instead");

    GGML_DEPRECATED(GGML_API struct ggml_tensor * ggml_rope_custom_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int                   n_dims,
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow),
        "use ggml_rope_ext_inplace instead");

    // compute correction dims for YaRN RoPE scaling
    GGML_API void ggml_rope_yarn_corr_dims(
        int n_dims, int n_ctx_orig, float freq_base, float beta_fast, float beta_slow, float dims[2]);

    // rotary position embedding backward, i.e compute dx from dy
    // a - dy
    GGML_API struct ggml_tensor * ggml_rope_ext_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a, // gradients of ggml_rope result
            struct ggml_tensor  * b, // positions
            struct ggml_tensor  * c, // freq factors
            int                   n_dims,
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow);

    GGML_API struct ggml_tensor * ggml_rope_multi_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            struct ggml_tensor  * c,
            int                   n_dims,
            int                   sections[4],
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow);


    // clamp
    // in-place, returns view(a)
    GGML_API struct ggml_tensor * ggml_clamp(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 min,
            float                 max);

    // im2col
    // converts data into a format that effectively results in a convolution when combined with matrix multiplication
    GGML_API struct ggml_tensor * ggml_im2col(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // convolution kernel
            struct ggml_tensor  * b,  // data
            int                   s0, // stride dimension 0
            int                   s1, // stride dimension 1
            int                   p0, // padding dimension 0
            int                   p1, // padding dimension 1
            int                   d0, // dilation dimension 0
            int                   d1, // dilation dimension 1
            bool                  is_2D,
            enum ggml_type        dst_type);

    GGML_API struct ggml_tensor * ggml_im2col_back(
        struct ggml_context * ctx,
        struct ggml_tensor  * a,  // convolution kernel
        struct ggml_tensor  * b,  // gradient of im2col output
        int64_t             * ne, // shape of im2col input
        int                   s0, // stride dimension 0
        int                   s1, // stride dimension 1
        int                   p0, // padding dimension 0
        int                   p1, // padding dimension 1
        int                   d0, // dilation dimension 0
        int                   d1, // dilation dimension 1
        bool                  is_2D);

    GGML_API struct ggml_tensor * ggml_conv_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,   // convolution kernel
            struct ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   p0,  // padding
            int                   d0); // dilation

    // conv_1d with padding = half
    // alias for ggml_conv_1d(a, b, s, a->ne[0]/2, d)
    GGML_API struct ggml_tensor* ggml_conv_1d_ph(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // convolution kernel
            struct ggml_tensor  * b,  // data
            int                   s,  // stride
            int                   d); // dilation

    // depthwise
    // TODO: this is very likely wrong for some cases! - needs more testing
    GGML_API struct ggml_tensor * ggml_conv_1d_dw(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,   // convolution kernel
            struct ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   p0,  // padding
            int                   d0); // dilation

    GGML_API struct ggml_tensor * ggml_conv_1d_dw_ph(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,   // convolution kernel
            struct ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   d0); // dilation

    GGML_API struct ggml_tensor * ggml_conv_transpose_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,   // convolution kernel
            struct ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   p0,  // padding
            int                   d0); // dilation

    GGML_API struct ggml_tensor * ggml_conv_2d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,   // convolution kernel
            struct ggml_tensor  * b,   // data
            int                   s0,  // stride dimension 0
            int                   s1,  // stride dimension 1
            int                   p0,  // padding dimension 0
            int                   p1,  // padding dimension 1
            int                   d0,  // dilation dimension 0
            int                   d1); // dilation dimension 1

    GGML_API struct ggml_tensor * ggml_im2col_3d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int64_t               IC,
            int                   s0, // stride width
            int                   s1, // stride height
            int                   s2, // stride depth
            int                   p0, // padding width
            int                   p1, // padding height
            int                   p2, // padding depth
            int                   d0, // dilation width
            int                   d1, // dilation height
            int                   d2, // dilation depth
            enum ggml_type        dst_type);

    // a: [OC*IC, KD, KH, KW]
    // b: [N*IC, ID, IH, IW]
    // result: [N*OC, OD, OH, OW]
    GGML_API struct ggml_tensor * ggml_conv_3d(
                struct ggml_context * ctx,
                struct ggml_tensor  * a,
                struct ggml_tensor  * b,
                int64_t               IC,
                int                   s0, // stride width
                int                   s1, // stride height
                int                   s2, // stride depth
                int                   p0, // padding width
                int                   p1, // padding height
                int                   p2, // padding depth
                int                   d0, // dilation width
                int                   d1, // dilation height
                int                   d2  // dilation depth
        );

    // kernel size is a->ne[0] x a->ne[1]
    // stride is equal to kernel size
    // padding is zero
    // example:
    // a:     16   16    3  768
    // b:   1024 1024    3    1
    // res:   64   64  768    1
    // used in sam
    GGML_API struct ggml_tensor * ggml_conv_2d_sk_p0(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // kernel size is a->ne[0] x a->ne[1]
    // stride is 1
    // padding is half
    // example:
    // a:      3    3    256  256
    // b:     64   64    256    1
    // res:   64   64    256    1
    // used in sam
    GGML_API struct ggml_tensor * ggml_conv_2d_s1_ph(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b);

    // depthwise (via im2col and mul_mat)
    GGML_API struct ggml_tensor * ggml_conv_2d_dw(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // convolution kernel
            struct ggml_tensor  * b,  // data
            int                  s0,  // stride dimension 0
            int                  s1,  // stride dimension 1
            int                  p0,  // padding dimension 0
            int                  p1,  // padding dimension 1
            int                  d0,  // dilation dimension 0
            int                  d1); // dilation dimension 1

    // Depthwise 2D convolution
    // may be faster than ggml_conv_2d_dw, but not available in all backends
    // a:   KW    KH    1    C    convolution kernel
    // b:   W     H     C    N    input data
    // res: W_out H_out C    N
    GGML_API struct ggml_tensor * ggml_conv_2d_dw_direct(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int                   stride0,
            int                   stride1,
            int                   pad0,
            int                   pad1,
            int                   dilation0,
            int                   dilation1);

    GGML_API struct ggml_tensor * ggml_conv_transpose_2d_p0(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            int                   stride);

    GGML_API struct ggml_tensor * ggml_conv_2d_direct(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,   // convolution kernel [KW, KH, IC, OC]
            struct ggml_tensor  * b,   // input data [W, H, C, N]
            int                   s0,  // stride dimension 0
            int                   s1,  // stride dimension 1
            int                   p0,  // padding dimension 0
            int                   p1,  // padding dimension 1
            int                   d0,  // dilation dimension 0
            int                   d1); // dilation dimension 1

    GGML_API struct ggml_tensor * ggml_conv_3d_direct(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,   // kernel [KW, KH, KD, IC * OC]
            struct ggml_tensor  * b,   // input  [W, H, D, C * N]
            int                   s0,  // stride
            int                   s1,
            int                   s2,
            int                   p0,  // padding
            int                   p1,
            int                   p2,
            int                   d0,  // dilation
            int                   d1,
            int                   d2,
            int                   n_channels,
            int                   n_batch,
            int                   n_channels_out);

    enum ggml_op_pool {
        GGML_OP_POOL_MAX,
        GGML_OP_POOL_AVG,
        GGML_OP_POOL_COUNT,
    };

    GGML_API struct ggml_tensor * ggml_pool_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            enum ggml_op_pool     op,
            int                   k0, // kernel size
            int                   s0, // stride
            int                   p0); // padding

    // the result will have 2*p0 padding for the first dimension
    // and 2*p1 padding for the second dimension
    GGML_API struct ggml_tensor * ggml_pool_2d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            enum ggml_op_pool     op,
            int                   k0,
            int                   k1,
            int                   s0,
            int                   s1,
            float                 p0,
            float                 p1);

    GGML_API struct ggml_tensor * ggml_pool_2d_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * af, // "a"/input used in forward pass
            enum ggml_op_pool     op,
            int                   k0,
            int                   k1,
            int                   s0,
            int                   s1,
            float                 p0,
            float                 p1);

    enum ggml_scale_mode {
        GGML_SCALE_MODE_NEAREST  = 0,
        GGML_SCALE_MODE_BILINEAR = 1,
        GGML_SCALE_MODE_BICUBIC  = 2,

        GGML_SCALE_MODE_COUNT
    };

    enum ggml_scale_flag {
        GGML_SCALE_FLAG_ALIGN_CORNERS = (1 << 8),
        GGML_SCALE_FLAG_ANTIALIAS     = (1 << 9),
    };

    // interpolate
    // multiplies ne0 and ne1 by scale factor
    GGML_API struct ggml_tensor * ggml_upscale(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   scale_factor,
            enum ggml_scale_mode  mode);

    // interpolate
    // interpolate scale to specified dimensions
    GGML_DEPRECATED(GGML_API struct ggml_tensor * ggml_upscale_ext(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   ne0,
            int                   ne1,
            int                   ne2,
            int                   ne3,
            enum ggml_scale_mode  mode),
        "use ggml_interpolate instead");

    // Up- or downsamples the input to the specified size.
    // 2D scale modes (eg. bilinear) are applied to the first two dimensions.
    GGML_API struct ggml_tensor * ggml_interpolate(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3,
            uint32_t              mode); // ggml_scale_mode [ | ggml_scale_flag...]

    // pad each dimension with zeros: [x, ..., x] -> [x, ..., x, 0, ..., 0]
    GGML_API struct ggml_tensor * ggml_pad(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                  p0,
            int                  p1,
            int                  p2,
            int                  p3);

    // pad each dimension with values on the other side of the torus (looping around)
    GGML_API struct ggml_tensor * ggml_pad_circular(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   p0,
            int                   p1,
            int                   p2,
            int                   p3);

    GGML_API struct ggml_tensor * ggml_pad_ext(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                  lp0,
            int                  rp0,
            int                  lp1,
            int                  rp1,
            int                  lp2,
            int                  rp2,
            int                  lp3,
            int                  rp3
            );

    // pad each dimension with values on the other side of the torus (looping around)
    GGML_API struct ggml_tensor * ggml_pad_ext_circular(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   lp0,
            int                   rp0,
            int                   lp1,
            int                   rp1,
            int                   lp2,
            int                   rp2,
            int                   lp3,
            int                   rp3);

    // pad each dimension with reflection: [a, b, c, d] -> [b, a, b, c, d, c]
    GGML_API struct ggml_tensor * ggml_pad_reflect_1d(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   p0,
            int                   p1);

    // Move tensor elements by an offset given for each dimension. Elements that
    // are shifted beyond the last position are wrapped around to the beginning.
    GGML_API struct ggml_tensor * ggml_roll(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   shift0,
            int                   shift1,
            int                   shift2,
            int                   shift3);

    // Convert matrix into a triangular one (upper, strict upper, lower or strict lower) by writing
    // zeroes everywhere outside the masked area
    GGML_API struct ggml_tensor * ggml_tri(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            enum ggml_tri_type    type);

    // Fill tensor a with constant c
    GGML_API struct ggml_tensor * ggml_fill(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 c);

    GGML_API struct ggml_tensor * ggml_fill_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            float                 c);

    // Ref: https://github.com/CompVis/stable-diffusion/blob/main/ldm/modules/diffusionmodules/util.py#L151
    // timesteps: [N,]
    // return: [N, dim]
    GGML_API struct ggml_tensor * ggml_timestep_embedding(
            struct ggml_context * ctx,
            struct ggml_tensor  * timesteps,
            int                   dim,
            int                   max_period);

    // sort rows
    enum ggml_sort_order {
        GGML_SORT_ORDER_ASC,
        GGML_SORT_ORDER_DESC,
    };

    GGML_API struct ggml_tensor * ggml_argsort(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            enum ggml_sort_order  order);

    // similar to ggml_top_k but implemented as `argsort` + `view`
    GGML_API struct ggml_tensor * ggml_argsort_top_k(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   k);

    // top k elements per row
    // note: the resulting top k indices are in no particular order
    GGML_API struct ggml_tensor * ggml_top_k(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   k);

    GGML_API struct ggml_tensor * ggml_arange(
            struct ggml_context * ctx,
            float                 start,
            float                 stop,
            float                 step);

    // q:    [n_embd_k, n_batch, n_head,    ne3 ]
    // k:    [n_embd_k, n_kv,    n_head_kv, ne3 ]
    // v:    [n_embd_v, n_kv,    n_head_kv, ne3 ] !! not transposed !!
    // mask: [n_kv,     n_batch, ne32,      ne33]
    // res:  [n_embd_v, n_head,  n_batch,   ne3 ] !! permuted !!
    //
    // broadcast:
    //   n_head % n_head_kv == 0
    //   n_head % ne32      == 0
    //   ne3    % ne33      == 0
    //
    GGML_API struct ggml_tensor * ggml_flash_attn_ext(
            struct ggml_context * ctx,
            struct ggml_tensor  * q,
            struct ggml_tensor  * k,
            struct ggml_tensor  * v,
            struct ggml_tensor  * mask,
            float                 scale,
            float                 max_bias,
            float                 logit_softcap);

    GGML_API void ggml_flash_attn_ext_set_prec(
            struct ggml_tensor * a,
            enum ggml_prec       prec);

    GGML_API enum ggml_prec ggml_flash_attn_ext_get_prec(
            const struct ggml_tensor * a);

    GGML_API void ggml_flash_attn_ext_add_sinks(
            struct ggml_tensor * a,
            struct ggml_tensor * sinks);

    // TODO: needs to be adapted to ggml_flash_attn_ext
    GGML_API struct ggml_tensor * ggml_flash_attn_back(
           struct ggml_context * ctx,
           struct ggml_tensor  * q,
           struct ggml_tensor  * k,
           struct ggml_tensor  * v,
           struct ggml_tensor  * d,
           bool                  masked);

    GGML_API struct ggml_tensor * ggml_ssm_conv(
            struct ggml_context * ctx,
            struct ggml_tensor  * sx,
            struct ggml_tensor  * c);

    GGML_API struct ggml_tensor * ggml_ssm_scan(
            struct ggml_context * ctx,
            struct ggml_tensor  * s,
            struct ggml_tensor  * x,
            struct ggml_tensor  * dt,
            struct ggml_tensor  * A,
            struct ggml_tensor  * B,
            struct ggml_tensor  * C,
            struct ggml_tensor  * ids);

    // partition into non-overlapping windows with padding if needed
    // example:
    // a:   768   64   64    1
    // w:    14
    // res: 768   14   14    25
    // used in sam
    GGML_API struct ggml_tensor * ggml_win_part(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   w);

    // reverse of ggml_win_part
    // used in sam
    GGML_API struct ggml_tensor * ggml_win_unpart(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   w0,
            int                   h0,
            int                   w);

    GGML_API struct ggml_tensor * ggml_unary(
            struct ggml_context * ctx,
             struct ggml_tensor * a,
             enum ggml_unary_op op);

    GGML_API struct ggml_tensor * ggml_unary_inplace(
        struct ggml_context * ctx,
        struct ggml_tensor  * a,
        enum ggml_unary_op op);

    // used in sam
    GGML_API struct ggml_tensor * ggml_get_rel_pos(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            int                   qh,
            int                   kh);

    // used in sam
    GGML_API struct ggml_tensor * ggml_add_rel_pos(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * pw,
            struct ggml_tensor  * ph);

    GGML_API struct ggml_tensor * ggml_add_rel_pos_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * pw,
            struct ggml_tensor  * ph);

    GGML_API struct ggml_tensor * ggml_rwkv_wkv6(
            struct ggml_context * ctx,
            struct ggml_tensor  * k,
            struct ggml_tensor  * v,
            struct ggml_tensor  * r,
            struct ggml_tensor  * tf,
            struct ggml_tensor  * td,
            struct ggml_tensor  * state);

    GGML_API struct ggml_tensor * ggml_gated_linear_attn(
            struct ggml_context * ctx,
            struct ggml_tensor  * k,
            struct ggml_tensor  * v,
            struct ggml_tensor  * q,
            struct ggml_tensor  * g,
            struct ggml_tensor  * state,
            float scale);

    GGML_API struct ggml_tensor * ggml_rwkv_wkv7(
            struct ggml_context * ctx,
            struct ggml_tensor  * r,
            struct ggml_tensor  * w,
            struct ggml_tensor  * k,
            struct ggml_tensor  * v,
            struct ggml_tensor  * a,
            struct ggml_tensor  * b,
            struct ggml_tensor  * state);

    /* Solves a specific equation of the form Ax=B, where A is a triangular matrix
    *  without zeroes on the diagonal (i.e. invertible).
    *  B can have any number of columns, but must have the same number of rows as A
    *  If A is [n, n] and B is [n, m], then the result will be [n, m] as well
    *  Has O(n^3) complexity (unlike most matrix ops out there), so use on cases
    *  where n > 100 sparingly, pre-chunk if necessary.
    *
    *  If left = false, solves xA=B instead
    *  If lower = false, assumes upper triangular instead
    *  If uni = true, assumes diagonal of A to be all ones (will override actual values)
    *
    *  TODO: currently only lower, right, non-unitriangular variant is implemented
    */
    GGML_API struct ggml_tensor * ggml_solve_tri(
        struct ggml_context * ctx,
        struct ggml_tensor  * a,
        struct ggml_tensor  * b,
        bool                  left,
        bool                  lower,
        bool                  uni);

    // TODO: add ggml_gated_delta_net_set_bcast() to be able to configure Q, K broadcast type: tiled vs interleaved [TAG_GGML_GDN_BCAST]
    // ref: https://github.com/ggml-org/llama.cpp/pull/19468#discussion_r2786394306
    GGML_API struct ggml_tensor * ggml_gated_delta_net(
            struct ggml_context * ctx,
            struct ggml_tensor  * q,
            struct ggml_tensor  * k,
            struct ggml_tensor  * v,
            struct ggml_tensor  * g,
            struct ggml_tensor  * beta,
            struct ggml_tensor  * state);

    // custom operators

    typedef void (*ggml_custom1_op_t)(struct ggml_tensor * dst , const struct ggml_tensor * a, int ith, int nth, void * userdata);
    typedef void (*ggml_custom2_op_t)(struct ggml_tensor * dst , const struct ggml_tensor * a, const struct ggml_tensor * b, int ith, int nth, void * userdata);
    typedef void (*ggml_custom3_op_t)(struct ggml_tensor * dst , const struct ggml_tensor * a, const struct ggml_tensor * b, const struct ggml_tensor * c, int ith, int nth, void * userdata);

#define GGML_N_TASKS_MAX (-1)
    // n_tasks == GGML_N_TASKS_MAX means to use max number of tasks

    GGML_API struct ggml_tensor * ggml_map_custom1(
            struct ggml_context   * ctx,
            struct ggml_tensor    * a,
            ggml_custom1_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    GGML_API struct ggml_tensor * ggml_map_custom1_inplace(
            struct ggml_context   * ctx,
            struct ggml_tensor    * a,
            ggml_custom1_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    GGML_API struct ggml_tensor * ggml_map_custom2(
            struct ggml_context   * ctx,
            struct ggml_tensor    * a,
            struct ggml_tensor    * b,
            ggml_custom2_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    GGML_API struct ggml_tensor * ggml_map_custom2_inplace(
            struct ggml_context   * ctx,
            struct ggml_tensor    * a,
            struct ggml_tensor    * b,
            ggml_custom2_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    GGML_API struct ggml_tensor * ggml_map_custom3(
            struct ggml_context   * ctx,
            struct ggml_tensor    * a,
            struct ggml_tensor    * b,
            struct ggml_tensor    * c,
            ggml_custom3_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    GGML_API struct ggml_tensor * ggml_map_custom3_inplace(
            struct ggml_context   * ctx,
            struct ggml_tensor    * a,
            struct ggml_tensor    * b,
            struct ggml_tensor    * c,
            ggml_custom3_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    typedef void (*ggml_custom_op_t)(struct ggml_tensor * dst , int ith, int nth, void * userdata);

    GGML_API struct ggml_tensor * ggml_custom_4d(
            struct ggml_context * ctx,
            enum ggml_type        type,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3,
            struct ggml_tensor ** args,
            int                   n_args,
            ggml_custom_op_t      fun,
            int                   n_tasks,
            void                * userdata);

    GGML_API struct ggml_tensor * ggml_custom_inplace(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor ** args,
            int                   n_args,
            ggml_custom_op_t      fun,
            int                   n_tasks,
            void                * userdata);

    // loss function

    GGML_API struct ggml_tensor * ggml_cross_entropy_loss(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // logits
            struct ggml_tensor  * b); // labels

    GGML_API struct ggml_tensor * ggml_cross_entropy_loss_back(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,  // logits
            struct ggml_tensor  * b,  // labels
            struct ggml_tensor  * c); // gradients of cross_entropy_loss result

    // AdamW optimizer step
    // Paper: https://arxiv.org/pdf/1711.05101v3.pdf
    // PyTorch: https://pytorch.org/docs/stable/generated/torch.optim.AdamW.html
    GGML_API struct ggml_tensor * ggml_opt_step_adamw(
            struct ggml_context * ctx,
            struct ggml_tensor  * a,
            struct ggml_tensor  * grad,
            struct ggml_tensor  * m,
            struct ggml_tensor  * v,
            struct ggml_tensor  * adamw_params); // parameters such as the learning rate

    // stochastic gradient descent step (with weight decay)
    GGML_API struct ggml_tensor * ggml_opt_step_sgd(
        struct ggml_context * ctx,
        struct ggml_tensor *  a,
        struct ggml_tensor *  grad,
        struct ggml_tensor *  sgd_params); // alpha, weight decay

    // build forward multiple tensors and select one of them for computing
    // this is useful for creating graphs that have constant topology but compute different things based on the input
    // ref: https://github.com/ggml-org/llama.cpp/pull/18550
    //
    // nodes:
    //   | - build forward into the graph but do not compute
    //   c - build forward into the graph and compute
    //
    //    |  |  ...  c  ...  |
    //    |  |  ...  c  ...  |
    //    |  |  ...  c  ...  |
    //   [0  1  ... idx ...  n-1]        <-- ggml_build_forward_select(..., n, idx)
    //               c
    //               c
    //
    // example:
    //   struct ggml_tensor * curs[3];
    //
    //   curs[0]  = compute0(...);
    //   curs[1]  = compute1(...);
    //   curs[2]  = compute2(...);
    //
    //   int idx = select_branch(some_input);
    //
    //   struct ggml_tensor * out = ggml_build_forward_select(cgraph, curs, 3, idx);
    //
    GGML_API struct ggml_tensor * ggml_build_forward_select(
            struct ggml_cgraph  * cgraph,
            struct ggml_tensor ** tensors,
            int                   n_tensors,
            int                   idx);

    GGML_API void ggml_build_forward_expand(
            struct ggml_cgraph * cgraph,
            struct ggml_tensor * tensor);

    GGML_API void ggml_build_backward_expand(
        struct ggml_context *  ctx,        // context for gradient computation
        struct ggml_cgraph  *  cgraph,
        struct ggml_tensor  ** grad_accs);

    // graph allocation in a context
    GGML_API struct ggml_cgraph * ggml_new_graph       (struct ggml_context * ctx); // size = GGML_DEFAULT_GRAPH_SIZE, grads = false
    GGML_API struct ggml_cgraph * ggml_new_graph_custom(struct ggml_context * ctx, size_t size, bool grads);
    GGML_API struct ggml_cgraph * ggml_graph_dup       (struct ggml_context * ctx, struct ggml_cgraph * cgraph, bool force_grads);
    GGML_API void                 ggml_graph_cpy       (struct ggml_cgraph * src, struct ggml_cgraph * dst);
    GGML_API void                 ggml_graph_reset     (struct ggml_cgraph * cgraph); // set regular grads + optimizer momenta to 0, set loss grad to 1
    GGML_API void                 ggml_graph_clear     (struct ggml_cgraph * cgraph);

    GGML_API int                   ggml_graph_size   (struct ggml_cgraph * cgraph);
    GGML_API struct ggml_tensor *  ggml_graph_node   (struct ggml_cgraph * cgraph, int i); // if i < 0, returns nodes[n_nodes + i]
    GGML_API struct ggml_tensor ** ggml_graph_nodes  (struct ggml_cgraph * cgraph);
    GGML_API int                   ggml_graph_n_nodes(struct ggml_cgraph * cgraph);

    GGML_API void   ggml_graph_add_node(struct ggml_cgraph * cgraph, struct ggml_tensor * tensor);

    GGML_API size_t ggml_graph_overhead(void);
    GGML_API size_t ggml_graph_overhead_custom(size_t size, bool grads);

    GGML_API struct ggml_tensor * ggml_graph_get_tensor  (const struct ggml_cgraph * cgraph, const char * name);
    GGML_API struct ggml_tensor * ggml_graph_get_grad    (const struct ggml_cgraph * cgraph, const struct ggml_tensor * node);
    GGML_API struct ggml_tensor * ggml_graph_get_grad_acc(const struct ggml_cgraph * cgraph, const struct ggml_tensor * node);

    // print info and performance information for the graph
    GGML_API void ggml_graph_print(const struct ggml_cgraph * cgraph);

    // dump the graph into a file using the dot format
    GGML_API void ggml_graph_dump_dot(const struct ggml_cgraph * gb, const struct ggml_cgraph * cgraph, const char * filename);

    // TODO these functions were sandwiched in the old optimization interface, is there a better place for them?
    typedef void (*ggml_log_callback)(enum ggml_log_level level, const char * text, void * user_data);

    // Set callback for all future logging events.
    // If this is not called, or NULL is supplied, everything is output on stderr.
    GGML_API void ggml_log_get(ggml_log_callback * log_callback, void ** user_data);
    GGML_API void ggml_log_set(ggml_log_callback   log_callback, void *  user_data);

    GGML_API struct ggml_tensor * ggml_set_zero(struct ggml_tensor * tensor);

    //
    // quantization
    //

    // - ggml_quantize_init can be called multiple times with the same type
    //   it will only initialize the quantization tables for the first call or after ggml_quantize_free
    //   automatically called by ggml_quantize_chunk for convenience
    //
    // - ggml_quantize_free will free any memory allocated by ggml_quantize_init
    //   call this at the end of the program to avoid memory leaks
    //
    // note: these are thread-safe
    //
    GGML_API void ggml_quantize_init(enum ggml_type type);
    GGML_API void ggml_quantize_free(void);

    // some quantization type cannot be used without an importance matrix
    GGML_API bool ggml_quantize_requires_imatrix(enum ggml_type type);

    // calls ggml_quantize_init internally (i.e. can allocate memory)
    GGML_API size_t ggml_quantize_chunk(
            enum ggml_type   type,
               const float * src,
                      void * dst,
                   int64_t   start,
                   int64_t   nrows,
                   int64_t   n_per_row,
               const float * imatrix);

#ifdef __cplusplus
    // restrict not standard in C++
#    if defined(__GNUC__)
#        define GGML_RESTRICT __restrict__
#    elif defined(__clang__)
#        define GGML_RESTRICT __restrict
#    elif defined(_MSC_VER)
#        define GGML_RESTRICT __restrict
#    else
#        define GGML_RESTRICT
#    endif
#else
#    if defined (_MSC_VER) && (__STDC_VERSION__ < 201112L)
#        define GGML_RESTRICT __restrict
#    else
#        define GGML_RESTRICT restrict
#    endif
#endif
    typedef void (*ggml_to_float_t)  (const void  * GGML_RESTRICT x, float * GGML_RESTRICT y, int64_t k);
    typedef void (*ggml_from_float_t)(const float * GGML_RESTRICT x, void  * GGML_RESTRICT y, int64_t k);

    struct ggml_type_traits {
        const char             * type_name;
        int64_t                  blck_size;
        int64_t                  blck_size_interleave; // interleave elements in blocks
        size_t                   type_size;
        bool                     is_quantized;
        ggml_to_float_t          to_float;
        ggml_from_float_t        from_float_ref;
    };

    GGML_API const struct ggml_type_traits * ggml_get_type_traits(enum ggml_type type);

    // ggml threadpool
    // TODO: currently, only a few functions are in the base ggml API, while the rest are in the CPU backend
    // the goal should be to create an API that other backends can use move everything to the ggml base

    // scheduling priorities
    enum ggml_sched_priority {
        GGML_SCHED_PRIO_LOW = -1,
        GGML_SCHED_PRIO_NORMAL,
        GGML_SCHED_PRIO_MEDIUM,
        GGML_SCHED_PRIO_HIGH,
        GGML_SCHED_PRIO_REALTIME
    };

    // threadpool params
    // Use ggml_threadpool_params_default() or ggml_threadpool_params_init() to populate the defaults
    struct ggml_threadpool_params {
        bool                cpumask[GGML_MAX_N_THREADS]; // mask of cpu cores (all-zeros means use default affinity settings)
        int                 n_threads;                   // number of threads
        enum ggml_sched_priority prio;                   // thread priority
        uint32_t            poll;                        // polling level (0 - no polling, 100 - aggressive polling)
        bool                strict_cpu;                  // strict cpu placement
        bool                paused;                      // start in paused state
    };

    struct ggml_threadpool;     // forward declaration, see ggml.c

    typedef struct ggml_threadpool * ggml_threadpool_t;

    GGML_API struct ggml_threadpool_params ggml_threadpool_params_default(int n_threads);
    GGML_API void                          ggml_threadpool_params_init   (struct ggml_threadpool_params * p, int n_threads);
    GGML_API bool                          ggml_threadpool_params_match  (const struct ggml_threadpool_params * p0, const struct ggml_threadpool_params * p1);

#ifdef  __cplusplus
}
#endif
