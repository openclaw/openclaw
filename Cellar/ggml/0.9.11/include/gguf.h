// This file contains functionality related to "GGUF" files, the binary file format used by ggml.
// GGUF files have the following structure:
//
// 1. File magic "GGUF" (4 bytes).
// 2. File version (uint32_t).
// 3. Number of ggml tensors in file (int64_t).
// 4. Number of key-value-pairs in file (int64_t).
// 5. For each KV pair:
//   1. The key (string).
//   2. The value type (gguf_type).
//   3a. If the value type is GGUF_TYPE_ARRAY:
//     1. The type of the array (gguf_type).
//     2. The number of elements in the array (uint64_t).
//     3. The binary representation of each element in the array.
//   3b. Otherwise:
//     1. The binary representation of the value.
// 6. For each ggml tensor:
//   1. The tensor name (string).
//   2. The number of dimensions of the tensor (uint32_t).
//   3. For each dimension:
//     1. The size of the tensor in the dimension (int64_t).
//   4. The tensor data type (ggml_type).
//   5. The tensor data offset in the tensor data binary blob (uint64_t).
// 7. The tensor data binary blob (optional, aligned).
//
// Strings are serialized as the string length (uint64_t) followed by the C string without the null terminator.
// All enums are stored as int32_t.
// All bool values are stored as int8_t.
// If the special key "general.alignment" (uint32_t) is defined it is used for alignment,
//   otherwise GGUF_DEFAULT_ALIGNMENT is used.
//
// Module maintainer: Johannes Gäßler (@JohannesGaessler, johannesg@5d6.de)

#pragma once

#include "ggml.h"

#include <stdbool.h>
#include <stdint.h>

#define GGUF_MAGIC   "GGUF"
#define GGUF_VERSION 3

#define GGUF_KEY_GENERAL_ALIGNMENT "general.alignment"

#define GGUF_DEFAULT_ALIGNMENT 32

#ifdef  __cplusplus
extern "C" {
#endif

    // types that can be stored as GGUF KV data
    enum gguf_type {
        GGUF_TYPE_UINT8   = 0,
        GGUF_TYPE_INT8    = 1,
        GGUF_TYPE_UINT16  = 2,
        GGUF_TYPE_INT16   = 3,
        GGUF_TYPE_UINT32  = 4,
        GGUF_TYPE_INT32   = 5,
        GGUF_TYPE_FLOAT32 = 6,
        GGUF_TYPE_BOOL    = 7,
        GGUF_TYPE_STRING  = 8,
        GGUF_TYPE_ARRAY   = 9,
        GGUF_TYPE_UINT64  = 10,
        GGUF_TYPE_INT64   = 11,
        GGUF_TYPE_FLOAT64 = 12,
        GGUF_TYPE_COUNT,       // marks the end of the enum
    };

    struct gguf_context;

    struct gguf_init_params {
        bool no_alloc;

        // if not NULL, create a ggml_context and allocate the tensor data in it
        struct ggml_context ** ctx;
    };

    GGML_API struct gguf_context * gguf_init_empty(void);
    GGML_API struct gguf_context * gguf_init_from_file_ptr(FILE * file, struct gguf_init_params params);
    GGML_API struct gguf_context * gguf_init_from_file(const char * fname, struct gguf_init_params params);
    //GGML_API struct gguf_context * gguf_init_from_buffer(..);

    GGML_API void gguf_free(struct gguf_context * ctx);

    GGML_API const char * gguf_type_name(enum gguf_type type);

    GGML_API uint32_t gguf_get_version    (const struct gguf_context * ctx);
    GGML_API size_t   gguf_get_alignment  (const struct gguf_context * ctx);
    GGML_API size_t   gguf_get_data_offset(const struct gguf_context * ctx);

    GGML_API int64_t      gguf_get_n_kv(const struct gguf_context * ctx);
    GGML_API int64_t      gguf_find_key(const struct gguf_context * ctx, const char * key); // returns -1 if key is not found
    GGML_API const char * gguf_get_key (const struct gguf_context * ctx, int64_t key_id);

    GGML_API enum gguf_type gguf_get_kv_type (const struct gguf_context * ctx, int64_t key_id);
    GGML_API enum gguf_type gguf_get_arr_type(const struct gguf_context * ctx, int64_t key_id);

    // will abort if the wrong type is used for the key
    GGML_API uint8_t      gguf_get_val_u8  (const struct gguf_context * ctx, int64_t key_id);
    GGML_API int8_t       gguf_get_val_i8  (const struct gguf_context * ctx, int64_t key_id);
    GGML_API uint16_t     gguf_get_val_u16 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API int16_t      gguf_get_val_i16 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API uint32_t     gguf_get_val_u32 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API int32_t      gguf_get_val_i32 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API float        gguf_get_val_f32 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API uint64_t     gguf_get_val_u64 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API int64_t      gguf_get_val_i64 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API double       gguf_get_val_f64 (const struct gguf_context * ctx, int64_t key_id);
    GGML_API bool         gguf_get_val_bool(const struct gguf_context * ctx, int64_t key_id);
    GGML_API const char * gguf_get_val_str (const struct gguf_context * ctx, int64_t key_id);
    GGML_API const void * gguf_get_val_data(const struct gguf_context * ctx, int64_t key_id);
    GGML_API size_t       gguf_get_arr_n   (const struct gguf_context * ctx, int64_t key_id);

    // get raw pointer to the first element of the array with the given key_id
    // for bool arrays, note that they are always stored as int8 on all platforms (usually this makes no difference)
    GGML_API const void * gguf_get_arr_data(const struct gguf_context * ctx, int64_t key_id);

    // get ith C string from array with given key_id
    GGML_API const char * gguf_get_arr_str (const struct gguf_context * ctx, int64_t key_id, size_t i);

    GGML_API int64_t        gguf_get_n_tensors    (const struct gguf_context * ctx);
    GGML_API int64_t        gguf_find_tensor      (const struct gguf_context * ctx, const char * name); // returns -1 if the tensor is not found
    GGML_API size_t         gguf_get_tensor_offset(const struct gguf_context * ctx, int64_t tensor_id);
    GGML_API const char *   gguf_get_tensor_name  (const struct gguf_context * ctx, int64_t tensor_id);
    GGML_API enum ggml_type gguf_get_tensor_type  (const struct gguf_context * ctx, int64_t tensor_id);
    GGML_API size_t         gguf_get_tensor_size  (const struct gguf_context * ctx, int64_t tensor_id);

    // removes key if it exists, returns id that the key had prior to removal (-1 if it didn't exist)
    GGML_API int64_t gguf_remove_key(struct gguf_context * ctx, const char * key);

    // overrides an existing KV pair or adds a new one, the new KV pair is always at the back
    GGML_API void gguf_set_val_u8  (struct gguf_context * ctx, const char * key, uint8_t      val);
    GGML_API void gguf_set_val_i8  (struct gguf_context * ctx, const char * key, int8_t       val);
    GGML_API void gguf_set_val_u16 (struct gguf_context * ctx, const char * key, uint16_t     val);
    GGML_API void gguf_set_val_i16 (struct gguf_context * ctx, const char * key, int16_t      val);
    GGML_API void gguf_set_val_u32 (struct gguf_context * ctx, const char * key, uint32_t     val);
    GGML_API void gguf_set_val_i32 (struct gguf_context * ctx, const char * key, int32_t      val);
    GGML_API void gguf_set_val_f32 (struct gguf_context * ctx, const char * key, float        val);
    GGML_API void gguf_set_val_u64 (struct gguf_context * ctx, const char * key, uint64_t     val);
    GGML_API void gguf_set_val_i64 (struct gguf_context * ctx, const char * key, int64_t      val);
    GGML_API void gguf_set_val_f64 (struct gguf_context * ctx, const char * key, double       val);
    GGML_API void gguf_set_val_bool(struct gguf_context * ctx, const char * key, bool         val);
    GGML_API void gguf_set_val_str (struct gguf_context * ctx, const char * key, const char * val);

    // creates a new array with n elements of the given type and copies the corresponding number of bytes from data
    GGML_API void gguf_set_arr_data(struct gguf_context * ctx, const char * key, enum gguf_type type, const void * data, size_t n);

    // creates a new array with n strings and copies the corresponding strings from data
    GGML_API void gguf_set_arr_str (struct gguf_context * ctx, const char * key, const char ** data, size_t n);

    // set or add KV pairs from another context
    GGML_API void gguf_set_kv(struct gguf_context * ctx, const struct gguf_context * src);

    // add tensor to GGUF context, tensor name must be unique
    GGML_API void gguf_add_tensor(struct gguf_context * ctx, const struct ggml_tensor * tensor);

    // after changing a tensor's type, the offsets of all tensors with higher indices are immediately recalculated
    //   in such a way that the tensor data remains as one contiguous block (except for padding)
    GGML_API void gguf_set_tensor_type(struct gguf_context * ctx, const char * name, enum ggml_type type);

    // assumes that at least gguf_get_tensor_size bytes can be read from data
    GGML_API void gguf_set_tensor_data(struct gguf_context * ctx, const char * name, const void * data);

    // writing gguf files can be done in 3 ways:
    //
    // - write the entire gguf_context to a binary file in a single pass:
    //
    //   gguf_write_to_file(ctx, fname, /*only_meta =*/ false);
    //
    // - write only the meta data to a file, then re-open the file and append the tensor data:
    //
    //   gguf_write_to_file(ctx, fname, /*only_meta =*/ true);
    //   FILE * f = fopen(fname, "ab");
    //   fwrite(f, ...); // write tensor data
    //   fclose(f);
    //
    // - first prepare a file with a placeholder for the meta data, write the tensor data, then write the meta data:
    //
    //   FILE * f = fopen(fname, "wb");
    //   const size_t size_meta = gguf_get_meta_size(ctx);
    //   fseek(f, size_meta, SEEK_SET);
    //   fwrite(f, ...); // write tensor data
    //   void * data = malloc(size_meta);
    //   gguf_get_meta_data(ctx, data);
    //   rewind(f);
    //   fwrite(data, 1, data, f);
    //   free(data);
    //   fclose(f);
    //

    // write the entire context to a binary file
    GGML_API bool gguf_write_to_file_ptr(const struct gguf_context * ctx, FILE * file, bool only_meta);
    GGML_API bool gguf_write_to_file(const struct gguf_context * ctx, const char * fname, bool only_meta);

    // get the size in bytes of the meta data (header, kv pairs, tensor info) including padding
    GGML_API size_t gguf_get_meta_size(const struct gguf_context * ctx);

    // writes the meta data to pointer "data"
    GGML_API void   gguf_get_meta_data(const struct gguf_context * ctx, void * data);

#ifdef  __cplusplus
}
#endif
