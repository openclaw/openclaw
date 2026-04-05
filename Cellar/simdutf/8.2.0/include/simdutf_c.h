/***
 * simdutf_c.h.h - C API for simdutf
 * This is currently experimental.
 * We are committed to keeping the C API, but there might be mistakes in our
 * implementation. Please report any issues you find.
 */

#ifndef SIMDUTF_C_H
#define SIMDUTF_C_H

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __has_include
  #if __has_include(<uchar.h>)
    #include <uchar.h>
  #else // __has_include(<uchar.h>)
    #define char16_t uint16_t
    #define char32_t uint32_t
  #endif // __has_include(<uchar.h>)
#else    // __has_include(<uchar.h>)
  #define char16_t uint16_t
  #define char32_t uint32_t
#endif // __has_include

#ifdef __cplusplus
extern "C" {
#endif

/* C-friendly subset of simdutf errors */
typedef enum simdutf_error_code {
  SIMDUTF_ERROR_SUCCESS = 0,
  SIMDUTF_ERROR_HEADER_BITS,
  SIMDUTF_ERROR_TOO_SHORT,
  SIMDUTF_ERROR_TOO_LONG,
  SIMDUTF_ERROR_OVERLONG,
  SIMDUTF_ERROR_TOO_LARGE,
  SIMDUTF_ERROR_SURROGATE,
  SIMDUTF_ERROR_INVALID_BASE64_CHARACTER,
  SIMDUTF_ERROR_BASE64_INPUT_REMAINDER,
  SIMDUTF_ERROR_BASE64_EXTRA_BITS,
  SIMDUTF_ERROR_OUTPUT_BUFFER_TOO_SMALL,
  SIMDUTF_ERROR_OTHER
} simdutf_error_code;

typedef struct simdutf_result {
  simdutf_error_code error;
  size_t count; /* position of error or number of code units validated */
} simdutf_result;

typedef enum simdutf_encoding_type {
  SIMDUTF_ENCODING_UNSPECIFIED = 0,
  SIMDUTF_ENCODING_UTF8 = 1,
  SIMDUTF_ENCODING_UTF16_LE = 2,
  SIMDUTF_ENCODING_UTF16_BE = 4,
  SIMDUTF_ENCODING_UTF32_LE = 8,
  SIMDUTF_ENCODING_UTF32_BE = 16
} simdutf_encoding_type;

/* Validate UTF-8: returns true iff input is valid UTF-8 */
bool simdutf_validate_utf8(const char *buf, size_t len);

/* Validate UTF-8 with detailed result */
simdutf_result simdutf_validate_utf8_with_errors(const char *buf, size_t len);

/* Encoding detection */
simdutf_encoding_type simdutf_autodetect_encoding(const char *input,
                                                  size_t length);
int simdutf_detect_encodings(const char *input, size_t length);

/* ASCII validation */
bool simdutf_validate_ascii(const char *buf, size_t len);
simdutf_result simdutf_validate_ascii_with_errors(const char *buf, size_t len);

/* UTF-16 ASCII checks */
bool simdutf_validate_utf16_as_ascii(const char16_t *buf, size_t len);
bool simdutf_validate_utf16be_as_ascii(const char16_t *buf, size_t len);
bool simdutf_validate_utf16le_as_ascii(const char16_t *buf, size_t len);

/* UTF-16/UTF-8/UTF-32 validation (native/endian-specific) */
bool simdutf_validate_utf16(const char16_t *buf, size_t len);
bool simdutf_validate_utf16le(const char16_t *buf, size_t len);
bool simdutf_validate_utf16be(const char16_t *buf, size_t len);
simdutf_result simdutf_validate_utf16_with_errors(const char16_t *buf,
                                                  size_t len);
simdutf_result simdutf_validate_utf16le_with_errors(const char16_t *buf,
                                                    size_t len);
simdutf_result simdutf_validate_utf16be_with_errors(const char16_t *buf,
                                                    size_t len);

bool simdutf_validate_utf32(const char32_t *buf, size_t len);
simdutf_result simdutf_validate_utf32_with_errors(const char32_t *buf,
                                                  size_t len);

/* to_well_formed UTF-16 helpers */
void simdutf_to_well_formed_utf16le(const char16_t *input, size_t len,
                                    char16_t *output);
void simdutf_to_well_formed_utf16be(const char16_t *input, size_t len,
                                    char16_t *output);
void simdutf_to_well_formed_utf16(const char16_t *input, size_t len,
                                  char16_t *output);

/* Counting */
size_t simdutf_count_utf16(const char16_t *input, size_t length);
size_t simdutf_count_utf16le(const char16_t *input, size_t length);
size_t simdutf_count_utf16be(const char16_t *input, size_t length);
size_t simdutf_count_utf8(const char *input, size_t length);

/* Length estimators */
size_t simdutf_utf8_length_from_latin1(const char *input, size_t length);
size_t simdutf_latin1_length_from_utf8(const char *input, size_t length);
size_t simdutf_latin1_length_from_utf16(size_t length);
size_t simdutf_latin1_length_from_utf32(size_t length);
size_t simdutf_utf16_length_from_utf8(const char *input, size_t length);
size_t simdutf_utf32_length_from_utf8(const char *input, size_t length);
size_t simdutf_utf8_length_from_utf16(const char16_t *input, size_t length);
size_t simdutf_utf8_length_from_utf32(const char32_t *input, size_t length);
simdutf_result
simdutf_utf8_length_from_utf16_with_replacement(const char16_t *input,
                                                size_t length);
size_t simdutf_utf8_length_from_utf16le(const char16_t *input, size_t length);
size_t simdutf_utf8_length_from_utf16be(const char16_t *input, size_t length);
simdutf_result
simdutf_utf8_length_from_utf16le_with_replacement(const char16_t *input,
                                                  size_t length);
simdutf_result
simdutf_utf8_length_from_utf16be_with_replacement(const char16_t *input,
                                                  size_t length);

/* Conversions: latin1 <-> utf8, utf8 <-> utf16/utf32, utf16 <-> utf8, etc. */
size_t simdutf_convert_latin1_to_utf8(const char *input, size_t length,
                                      char *output);
size_t simdutf_convert_latin1_to_utf8_safe(const char *input, size_t length,
                                           char *output, size_t utf8_len);
size_t simdutf_convert_latin1_to_utf16le(const char *input, size_t length,
                                         char16_t *output);
size_t simdutf_convert_latin1_to_utf16be(const char *input, size_t length,
                                         char16_t *output);
size_t simdutf_convert_latin1_to_utf16(const char *input, size_t length,
                                       char16_t *output);
size_t simdutf_convert_latin1_to_utf32(const char *input, size_t length,
                                       char32_t *output);

size_t simdutf_convert_utf8_to_latin1(const char *input, size_t length,
                                      char *output);
size_t simdutf_convert_utf8_to_utf16le(const char *input, size_t length,
                                       char16_t *output);
size_t simdutf_convert_utf8_to_utf16be(const char *input, size_t length,
                                       char16_t *output);
size_t simdutf_convert_utf8_to_utf16(const char *input, size_t length,
                                     char16_t *output);

size_t simdutf_convert_utf8_to_utf32(const char *input, size_t length,
                                     char32_t *output);
simdutf_result simdutf_convert_utf8_to_latin1_with_errors(const char *input,
                                                          size_t length,
                                                          char *output);
simdutf_result simdutf_convert_utf8_to_utf16_with_errors(const char *input,
                                                         size_t length,
                                                         char16_t *output);
simdutf_result simdutf_convert_utf8_to_utf16le_with_errors(const char *input,
                                                           size_t length,
                                                           char16_t *output);
simdutf_result simdutf_convert_utf8_to_utf16be_with_errors(const char *input,
                                                           size_t length,
                                                           char16_t *output);
simdutf_result simdutf_convert_utf8_to_utf32_with_errors(const char *input,
                                                         size_t length,
                                                         char32_t *output);

/* Conversions assuming valid input */
size_t simdutf_convert_valid_utf8_to_latin1(const char *input, size_t length,
                                            char *output);
size_t simdutf_convert_valid_utf8_to_utf16le(const char *input, size_t length,
                                             char16_t *output);
size_t simdutf_convert_valid_utf8_to_utf16be(const char *input, size_t length,
                                             char16_t *output);
size_t simdutf_convert_valid_utf8_to_utf32(const char *input, size_t length,
                                           char32_t *output);

/* UTF-16 -> UTF-8 and related conversions */
size_t simdutf_convert_utf16_to_utf8(const char16_t *input, size_t length,
                                     char *output);
size_t simdutf_convert_utf16le_to_utf8(const char16_t *input, size_t length,
                                       char *output);
size_t simdutf_convert_utf16be_to_utf8(const char16_t *input, size_t length,
                                       char *output);
size_t simdutf_convert_utf16_to_utf8_safe(const char16_t *input, size_t length,
                                          char *output, size_t utf8_len);
size_t simdutf_convert_utf16_to_latin1(const char16_t *input, size_t length,
                                       char *output);
size_t simdutf_convert_utf16le_to_latin1(const char16_t *input, size_t length,
                                         char *output);
size_t simdutf_convert_utf16be_to_latin1(const char16_t *input, size_t length,
                                         char *output);
simdutf_result
simdutf_convert_utf16_to_latin1_with_errors(const char16_t *input,
                                            size_t length, char *output);
simdutf_result
simdutf_convert_utf16le_to_latin1_with_errors(const char16_t *input,
                                              size_t length, char *output);
simdutf_result
simdutf_convert_utf16be_to_latin1_with_errors(const char16_t *input,
                                              size_t length, char *output);

simdutf_result simdutf_convert_utf16_to_utf8_with_errors(const char16_t *input,
                                                         size_t length,
                                                         char *output);
simdutf_result
simdutf_convert_utf16le_to_utf8_with_errors(const char16_t *input,
                                            size_t length, char *output);
simdutf_result
simdutf_convert_utf16be_to_utf8_with_errors(const char16_t *input,
                                            size_t length, char *output);

size_t simdutf_convert_valid_utf16_to_utf8(const char16_t *input, size_t length,
                                           char *output);
size_t simdutf_convert_valid_utf16_to_latin1(const char16_t *input,
                                             size_t length, char *output);
size_t simdutf_convert_valid_utf16le_to_latin1(const char16_t *input,
                                               size_t length, char *output);
size_t simdutf_convert_valid_utf16be_to_latin1(const char16_t *input,
                                               size_t length, char *output);

size_t simdutf_convert_valid_utf16le_to_utf8(const char16_t *input,
                                             size_t length, char *output);
size_t simdutf_convert_valid_utf16be_to_utf8(const char16_t *input,
                                             size_t length, char *output);

/* UTF-16 <-> UTF-32 conversions */
size_t simdutf_convert_utf16_to_utf32(const char16_t *input, size_t length,
                                      char32_t *output);
size_t simdutf_convert_utf16le_to_utf32(const char16_t *input, size_t length,
                                        char32_t *output);
size_t simdutf_convert_utf16be_to_utf32(const char16_t *input, size_t length,
                                        char32_t *output);
simdutf_result simdutf_convert_utf16_to_utf32_with_errors(const char16_t *input,
                                                          size_t length,
                                                          char32_t *output);
simdutf_result
simdutf_convert_utf16le_to_utf32_with_errors(const char16_t *input,
                                             size_t length, char32_t *output);
simdutf_result
simdutf_convert_utf16be_to_utf32_with_errors(const char16_t *input,
                                             size_t length, char32_t *output);

/* Valid UTF-16 conversions */
size_t simdutf_convert_valid_utf16_to_utf32(const char16_t *input,
                                            size_t length, char32_t *output);
size_t simdutf_convert_valid_utf16le_to_utf32(const char16_t *input,
                                              size_t length, char32_t *output);
size_t simdutf_convert_valid_utf16be_to_utf32(const char16_t *input,
                                              size_t length, char32_t *output);

/* UTF-32 -> ... conversions */
size_t simdutf_convert_utf32_to_utf8(const char32_t *input, size_t length,
                                     char *output);
simdutf_result simdutf_convert_utf32_to_utf8_with_errors(const char32_t *input,
                                                         size_t length,
                                                         char *output);
size_t simdutf_convert_valid_utf32_to_utf8(const char32_t *input, size_t length,
                                           char *output);

size_t simdutf_convert_utf32_to_utf16(const char32_t *input, size_t length,
                                      char16_t *output);
size_t simdutf_convert_utf32_to_utf16le(const char32_t *input, size_t length,
                                        char16_t *output);
size_t simdutf_convert_utf32_to_utf16be(const char32_t *input, size_t length,
                                        char16_t *output);
simdutf_result
simdutf_convert_utf32_to_latin1_with_errors(const char32_t *input,
                                            size_t length, char *output);

/* --- Find helpers --- */
const char *simdutf_find(const char *start, const char *end, char character);
const char16_t *simdutf_find_utf16(const char16_t *start, const char16_t *end,
                                   char16_t character);

/* --- Base64 enums and helpers --- */
typedef enum simdutf_base64_options {
  SIMDUTF_BASE64_DEFAULT = 0,
  SIMDUTF_BASE64_URL = 1,
  SIMDUTF_BASE64_DEFAULT_NO_PADDING = 2,
  SIMDUTF_BASE64_URL_WITH_PADDING = 3,
  SIMDUTF_BASE64_DEFAULT_ACCEPT_GARBAGE = 4,
  SIMDUTF_BASE64_URL_ACCEPT_GARBAGE = 5,
  SIMDUTF_BASE64_DEFAULT_OR_URL = 8,
  SIMDUTF_BASE64_DEFAULT_OR_URL_ACCEPT_GARBAGE = 12
} simdutf_base64_options;

typedef enum simdutf_last_chunk_handling_options {
  SIMDUTF_LAST_CHUNK_LOOSE = 0,
  SIMDUTF_LAST_CHUNK_STRICT = 1,
  SIMDUTF_LAST_CHUNK_STOP_BEFORE_PARTIAL = 2,
  SIMDUTF_LAST_CHUNK_ONLY_FULL_CHUNKS = 3
} simdutf_last_chunk_handling_options;

/* maximal binary length estimators */
size_t simdutf_maximal_binary_length_from_base64(const char *input,
                                                 size_t length);
size_t simdutf_maximal_binary_length_from_base64_utf16(const char16_t *input,
                                                       size_t length);

/* base64 decoding/encoding */
simdutf_result simdutf_base64_to_binary(
    const char *input, size_t length, char *output,
    simdutf_base64_options options,
    simdutf_last_chunk_handling_options last_chunk_options);
simdutf_result simdutf_base64_to_binary_utf16(
    const char16_t *input, size_t length, char *output,
    simdutf_base64_options options,
    simdutf_last_chunk_handling_options last_chunk_options);

size_t simdutf_base64_length_from_binary(size_t length,
                                         simdutf_base64_options options);
size_t simdutf_base64_length_from_binary_with_lines(
    size_t length, simdutf_base64_options options, size_t line_length);

size_t simdutf_binary_to_base64(const char *input, size_t length, char *output,
                                simdutf_base64_options options);
size_t simdutf_binary_to_base64_with_lines(const char *input, size_t length,
                                           char *output, size_t line_length,
                                           simdutf_base64_options options);

/* safe decoding that provides an in/out outlen parameter */
simdutf_result simdutf_base64_to_binary_safe(
    const char *input, size_t length, char *output, size_t *outlen,
    simdutf_base64_options options,
    simdutf_last_chunk_handling_options last_chunk_options,
    bool decode_up_to_bad_char);
simdutf_result simdutf_base64_to_binary_safe_utf16(
    const char16_t *input, size_t length, char *output, size_t *outlen,
    simdutf_base64_options options,
    simdutf_last_chunk_handling_options last_chunk_options,
    bool decode_up_to_bad_char);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* SIMDUTF_C_H */
