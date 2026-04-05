#ifndef SIMDUTF_IMPLEMENTATION_H
#define SIMDUTF_IMPLEMENTATION_H
#if !defined(SIMDUTF_NO_THREADS)
  #include <atomic>
#endif
#include <string>
#ifdef SIMDUTF_INTERNAL_TESTS
  #include <vector>
#endif
#include "simdutf/common_defs.h"
#include "simdutf/compiler_check.h"
#include "simdutf/encoding_types.h"
#include "simdutf/error.h"
#include "simdutf/internal/isadetection.h"

#if SIMDUTF_SPAN
  #include <concepts>
  #include <type_traits>
  #include <span>
  #include <tuple>
#endif
#if SIMDUTF_CPLUSPLUS17
  #include <string_view>
#endif
// The following defines are conditionally enabled/disabled during amalgamation.
// By default all features are enabled, regular code shouldn't check them. Only
// when user code really relies of a selected subset, it's good to verify these
// flags, like:
//
//      #if !SIMDUTF_FEATURE_UTF16
//      #   error("Please amalgamate simdutf with UTF-16 support")
//      #endif
//
#define SIMDUTF_FEATURE_DETECT_ENCODING 1
#define SIMDUTF_FEATURE_ASCII 1
#define SIMDUTF_FEATURE_LATIN1 1
#define SIMDUTF_FEATURE_UTF8 1
#define SIMDUTF_FEATURE_UTF16 1
#define SIMDUTF_FEATURE_UTF32 1
#define SIMDUTF_FEATURE_BASE64 1

#if SIMDUTF_CPLUSPLUS23
  #include <simdutf/constexpr_ptr.h>
#endif

#if SIMDUTF_SPAN
/// helpers placed in namespace detail are not a part of the public API
namespace simdutf {
namespace detail {
/**
 * matches a byte, in the many ways C++ allows. note that these
 * are all distinct types.
 */
template <typename T>
concept byte_like = std::is_same_v<T, std::byte> ||     //
                    std::is_same_v<T, char> ||          //
                    std::is_same_v<T, signed char> ||   //
                    std::is_same_v<T, unsigned char> || //
                    std::is_same_v<T, char8_t>;

template <typename T>
concept is_byte_like = byte_like<std::remove_cvref_t<T>>;

template <typename T>
concept is_pointer = std::is_pointer_v<T>;

/**
 * matches anything that behaves like std::span and points to character-like
 * data such as: std::byte, char, unsigned char, signed char, std::int8_t,
 * std::uint8_t
 */
template <typename T>
concept input_span_of_byte_like = requires(const T &t) {
  { t.size() } noexcept -> std::convertible_to<std::size_t>;
  { t.data() } noexcept -> is_pointer;
  { *t.data() } noexcept -> is_byte_like;
};

template <typename T>
concept is_mutable = !std::is_const_v<std::remove_reference_t<T>>;

/**
 * like span_of_byte_like, but for an output span (intended to be written to)
 */
template <typename T>
concept output_span_of_byte_like = requires(T &t) {
  { t.size() } noexcept -> std::convertible_to<std::size_t>;
  { t.data() } noexcept -> is_pointer;
  { *t.data() } noexcept -> is_byte_like;
  { *t.data() } noexcept -> is_mutable;
};

/**
 * a pointer like object, when indexed, results in a byte like result.
 * valid examples: char*, const char*, std::array<char,10>
 * invalid examples: int*, std::array<int,10>
 */
template <class InputPtr>
concept indexes_into_byte_like = requires(InputPtr p) {
  { std::decay_t<decltype(p[0])>{} } -> simdutf::detail::byte_like;
};
template <class InputPtr>
concept indexes_into_utf16 = requires(InputPtr p) {
  { std::decay_t<decltype(p[0])>{} } -> std::same_as<char16_t>;
};
template <class InputPtr>
concept indexes_into_utf32 = requires(InputPtr p) {
  { std::decay_t<decltype(p[0])>{} } -> std::same_as<char32_t>;
};

template <class InputPtr>
concept index_assignable_from_char = requires(InputPtr p, char s) {
  { p[0] = s };
};

/**
 * a pointer like object that results in a uint32_t when indexed.
 * valid examples: uint32_t*
 */
template <class InputPtr>
concept indexes_into_uint32 = requires(InputPtr p) {
  { std::decay_t<decltype(p[0])>{} } -> std::same_as<std::uint32_t>;
};
} // namespace detail
} // namespace simdutf
#endif // SIMDUTF_SPAN

// these includes are needed for constexpr support. they are
// not part of the public api.
#include <simdutf/scalar/swap_bytes.h>
#include <simdutf/scalar/ascii.h>
#include <simdutf/scalar/atomic_util.h>
#include <simdutf/scalar/latin1.h>
#include <simdutf/scalar/latin1_to_utf16/latin1_to_utf16.h>
#include <simdutf/scalar/latin1_to_utf32/latin1_to_utf32.h>
#include <simdutf/scalar/latin1_to_utf8/latin1_to_utf8.h>
#include <simdutf/scalar/utf16.h>
#include <simdutf/scalar/utf16_to_latin1/utf16_to_latin1.h>
#include <simdutf/scalar/utf16_to_latin1/valid_utf16_to_latin1.h>
#include <simdutf/scalar/utf16_to_utf32/utf16_to_utf32.h>
#include <simdutf/scalar/utf16_to_utf32/valid_utf16_to_utf32.h>
#include <simdutf/scalar/utf16_to_utf8/utf16_to_utf8.h>
#include <simdutf/scalar/utf16_to_utf8/valid_utf16_to_utf8.h>
#include <simdutf/scalar/utf32.h>
#include <simdutf/scalar/utf32_to_latin1/utf32_to_latin1.h>
#include <simdutf/scalar/utf32_to_latin1/valid_utf32_to_latin1.h>
#include <simdutf/scalar/utf32_to_utf16/utf32_to_utf16.h>
#include <simdutf/scalar/utf32_to_utf16/valid_utf32_to_utf16.h>
#include <simdutf/scalar/utf32_to_utf8/utf32_to_utf8.h>
#include <simdutf/scalar/utf32_to_utf8/valid_utf32_to_utf8.h>
#include <simdutf/scalar/utf8.h>
#include <simdutf/scalar/utf8_to_latin1/utf8_to_latin1.h>
#include <simdutf/scalar/utf8_to_latin1/valid_utf8_to_latin1.h>
#include <simdutf/scalar/utf8_to_utf16/utf8_to_utf16.h>
#include <simdutf/scalar/utf8_to_utf16/valid_utf8_to_utf16.h>
#include <simdutf/scalar/utf8_to_utf32/utf8_to_utf32.h>
#include <simdutf/scalar/utf8_to_utf32/valid_utf8_to_utf32.h>

namespace simdutf {

constexpr size_t default_line_length =
    76; ///< default line length for base64 encoding with lines

#if SIMDUTF_FEATURE_DETECT_ENCODING
/**
 * Autodetect the encoding of the input, a single encoding is recommended.
 * E.g., the function might return simdutf::encoding_type::UTF8,
 * simdutf::encoding_type::UTF16_LE, simdutf::encoding_type::UTF16_BE, or
 * simdutf::encoding_type::UTF32_LE.
 *
 * @param input the string to analyze.
 * @param length the length of the string in bytes.
 * @return the detected encoding type
 */
simdutf_warn_unused simdutf::encoding_type
autodetect_encoding(const char *input, size_t length) noexcept;
simdutf_really_inline simdutf_warn_unused simdutf::encoding_type
autodetect_encoding(const uint8_t *input, size_t length) noexcept {
  return autodetect_encoding(reinterpret_cast<const char *>(input), length);
}
  #if SIMDUTF_SPAN
/**
 * Autodetect the encoding of the input, a single encoding is recommended.
 * E.g., the function might return simdutf::encoding_type::UTF8,
 * simdutf::encoding_type::UTF16_LE, simdutf::encoding_type::UTF16_BE, or
 * simdutf::encoding_type::UTF32_LE.
 *
 * @param input the string to analyze. can be a anything span-like that has a
 * data() and size() that points to character data: std::string,
 * std::string_view, std::vector<char>, std::span<const std::byte> etc.
 * @return the detected encoding type
 */
simdutf_really_inline simdutf_warn_unused simdutf::encoding_type
autodetect_encoding(
    const detail::input_span_of_byte_like auto &input) noexcept {
  return autodetect_encoding(reinterpret_cast<const char *>(input.data()),
                             input.size());
}
  #endif // SIMDUTF_SPAN

/**
 * Autodetect the possible encodings of the input in one pass.
 * E.g., if the input might be UTF-16LE or UTF-8, this function returns
 * the value (simdutf::encoding_type::UTF8 | simdutf::encoding_type::UTF16_LE).
 *
 * Overridden by each implementation.
 *
 * @param input the string to analyze.
 * @param length the length of the string in bytes.
 * @return the detected encoding type
 */
simdutf_warn_unused int detect_encodings(const char *input,
                                         size_t length) noexcept;
simdutf_really_inline simdutf_warn_unused int
detect_encodings(const uint8_t *input, size_t length) noexcept {
  return detect_encodings(reinterpret_cast<const char *>(input), length);
}
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused int
detect_encodings(const detail::input_span_of_byte_like auto &input) noexcept {
  return detect_encodings(reinterpret_cast<const char *>(input.data()),
                          input.size());
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_UTF8 || SIMDUTF_FEATURE_DETECT_ENCODING
/**
 * Validate the UTF-8 string. This function may be best when you expect
 * the input to be almost always valid. Otherwise, consider using
 * validate_utf8_with_errors.
 *
 * Overridden by each implementation.
 *
 * @param buf the UTF-8 string to validate.
 * @param len the length of the string in bytes.
 * @return true if and only if the string is valid UTF-8.
 */
simdutf_warn_unused bool validate_utf8(const char *buf, size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_constexpr23 simdutf_really_inline simdutf_warn_unused bool
validate_utf8(const detail::input_span_of_byte_like auto &input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8::validate(
        detail::constexpr_cast_ptr<uint8_t>(input.data()), input.size());
  } else
    #endif
  {
    return validate_utf8(reinterpret_cast<const char *>(input.data()),
                         input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 || SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_UTF8
/**
 * Validate the UTF-8 string and stop on error.
 *
 * Overridden by each implementation.
 *
 * @param buf the UTF-8 string to validate.
 * @param len the length of the string in bytes.
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of code units validated if
 * successful.
 */
simdutf_warn_unused result validate_utf8_with_errors(const char *buf,
                                                     size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 simdutf_warn_unused result
validate_utf8_with_errors(
    const detail::input_span_of_byte_like auto &input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8::validate_with_errors(
        detail::constexpr_cast_ptr<uint8_t>(input.data()), input.size());
  } else
    #endif
  {
    return validate_utf8_with_errors(
        reinterpret_cast<const char *>(input.data()), input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8

#if SIMDUTF_FEATURE_ASCII
/**
 * Validate the ASCII string.
 *
 * Overridden by each implementation.
 *
 * @param buf the ASCII string to validate.
 * @param len the length of the string in bytes.
 * @return true if and only if the string is valid ASCII.
 */
simdutf_warn_unused bool validate_ascii(const char *buf, size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 bool
validate_ascii(const detail::input_span_of_byte_like auto &input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::ascii::validate(
        detail::constexpr_cast_ptr<std::uint8_t>(input.data()), input.size());
  } else
    #endif
  {
    return validate_ascii(reinterpret_cast<const char *>(input.data()),
                          input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Validate the ASCII string and stop on error. It might be faster than
 * validate_utf8 when an error is expected to occur early.
 *
 * Overridden by each implementation.
 *
 * @param buf the ASCII string to validate.
 * @param len the length of the string in bytes.
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of code units validated if
 * successful.
 */
simdutf_warn_unused result validate_ascii_with_errors(const char *buf,
                                                      size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
validate_ascii_with_errors(
    const detail::input_span_of_byte_like auto &input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::ascii::validate_with_errors(
        detail::constexpr_cast_ptr<std::uint8_t>(input.data()), input.size());
  } else
    #endif
  {
    return validate_ascii_with_errors(
        reinterpret_cast<const char *>(input.data()), input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_ASCII

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_ASCII
/**
 * Validate the ASCII string as a UTF-16 sequence.
 * An UTF-16 sequence is considered an ASCII sequence
 * if it could be converted to an ASCII string losslessly.
 *
 * Overridden by each implementation.
 *
 * @param buf the UTF-16 string to validate.
 * @param len the length of the string in bytes.
 * @return true if and only if the string is valid ASCII.
 */
simdutf_warn_unused bool validate_utf16_as_ascii(const char16_t *buf,
                                                 size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 bool
validate_utf16_as_ascii(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate_as_ascii<endianness::NATIVE>(input.data(),
                                                                input.size());
  } else
    #endif
  {
    return validate_utf16_as_ascii(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Validate the ASCII string as a UTF-16BE sequence.
 * An UTF-16 sequence is considered an ASCII sequence
 * if it could be converted to an ASCII string losslessly.
 *
 * Overridden by each implementation.
 *
 * @param buf the UTF-16BE string to validate.
 * @param len the length of the string in bytes.
 * @return true if and only if the string is valid ASCII.
 */
simdutf_warn_unused bool validate_utf16be_as_ascii(const char16_t *buf,
                                                   size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 bool
validate_utf16be_as_ascii(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate_as_ascii<endianness::BIG>(input.data(),
                                                             input.size());
  } else
    #endif
  {
    return validate_utf16be_as_ascii(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Validate the ASCII string as a UTF-16LE sequence.
 * An UTF-16 sequence is considered an ASCII sequence
 * if it could be converted to an ASCII string losslessly.
 *
 * Overridden by each implementation.
 *
 * @param buf the UTF-16LE string to validate.
 * @param len the length of the string in bytes.
 * @return true if and only if the string is valid ASCII.
 */
simdutf_warn_unused bool validate_utf16le_as_ascii(const char16_t *buf,
                                                   size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 bool
validate_utf16le_as_ascii(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate_as_ascii<endianness::LITTLE>(input.data(),
                                                                input.size());
  } else
    #endif
  {
    return validate_utf16le_as_ascii(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_ASCII

#if SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness; Validate the UTF-16 string.
 * This function may be best when you expect the input to be almost always
 * valid. Otherwise, consider using validate_utf16_with_errors.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-16 string to validate.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @return true if and only if the string is valid UTF-16.
 */
simdutf_warn_unused bool validate_utf16(const char16_t *buf,
                                        size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 bool
validate_utf16(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate<endianness::NATIVE>(input.data(),
                                                       input.size());
  } else
    #endif
  {
    return validate_utf16(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF16 || SIMDUTF_FEATURE_DETECT_ENCODING
/**
 * Validate the UTF-16LE string. This function may be best when you expect
 * the input to be almost always valid. Otherwise, consider using
 * validate_utf16le_with_errors.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-16LE string to validate.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @return true if and only if the string is valid UTF-16LE.
 */
simdutf_warn_unused bool validate_utf16le(const char16_t *buf,
                                          size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 simdutf_warn_unused bool
validate_utf16le(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate<endianness::LITTLE>(input.data(),
                                                       input.size());
  } else
    #endif
  {
    return validate_utf16le(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 || SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_UTF16
/**
 * Validate the UTF-16BE string. This function may be best when you expect
 * the input to be almost always valid. Otherwise, consider using
 * validate_utf16be_with_errors.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-16BE string to validate.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @return true if and only if the string is valid UTF-16BE.
 */
simdutf_warn_unused bool validate_utf16be(const char16_t *buf,
                                          size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 bool
validate_utf16be(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate<endianness::BIG>(input.data(), input.size());
  } else
    #endif
  {
    return validate_utf16be(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness; Validate the UTF-16 string and stop on error.
 * It might be faster than validate_utf16 when an error is expected to occur
 * early.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-16 string to validate.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of code units validated if
 * successful.
 */
simdutf_warn_unused result validate_utf16_with_errors(const char16_t *buf,
                                                      size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
validate_utf16_with_errors(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate_with_errors<endianness::NATIVE>(
        input.data(), input.size());
  } else
    #endif
  {
    return validate_utf16_with_errors(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Validate the UTF-16LE string and stop on error. It might be faster than
 * validate_utf16le when an error is expected to occur early.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-16LE string to validate.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of code units validated if
 * successful.
 */
simdutf_warn_unused result validate_utf16le_with_errors(const char16_t *buf,
                                                        size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
validate_utf16le_with_errors(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate_with_errors<endianness::LITTLE>(
        input.data(), input.size());
  } else
    #endif
  {
    return validate_utf16le_with_errors(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Validate the UTF-16BE string and stop on error. It might be faster than
 * validate_utf16be when an error is expected to occur early.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-16BE string to validate.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of code units validated if
 * successful.
 */
simdutf_warn_unused result validate_utf16be_with_errors(const char16_t *buf,
                                                        size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
validate_utf16be_with_errors(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::validate_with_errors<endianness::BIG>(input.data(),
                                                                input.size());
  } else
    #endif
  {
    return validate_utf16be_with_errors(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Fixes an ill-formed UTF-16LE string by replacing mismatched surrogates with
 * the Unicode replacement character U+FFFD. If input and output points to
 * different memory areas, the procedure copies string, and it's expected that
 * output memory is at least as big as the input. It's also possible to set
 * input equal output, that makes replacements an in-place operation.
 *
 * @param input the UTF-16LE string to correct.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @param output the output buffer.
 */
void to_well_formed_utf16le(const char16_t *input, size_t len,
                            char16_t *output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 void
to_well_formed_utf16le(std::span<const char16_t> input,
                       std::span<char16_t> output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    scalar::utf16::to_well_formed_utf16<endianness::LITTLE>(
        input.data(), input.size(), output.data());
  } else
    #endif
  {
    to_well_formed_utf16le(input.data(), input.size(), output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Fixes an ill-formed UTF-16BE string by replacing mismatched surrogates with
 * the Unicode replacement character U+FFFD. If input and output points to
 * different memory areas, the procedure copies string, and it's expected that
 * output memory is at least as big as the input. It's also possible to set
 * input equal output, that makes replacements an in-place operation.
 *
 * @param input the UTF-16BE string to correct.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @param output the output buffer.
 */
void to_well_formed_utf16be(const char16_t *input, size_t len,
                            char16_t *output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 void
to_well_formed_utf16be(std::span<const char16_t> input,
                       std::span<char16_t> output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    scalar::utf16::to_well_formed_utf16<endianness::BIG>(
        input.data(), input.size(), output.data());
  } else
    #endif
  {
    to_well_formed_utf16be(input.data(), input.size(), output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Fixes an ill-formed UTF-16 string by replacing mismatched surrogates with the
 * Unicode replacement character U+FFFD. If input and output points to different
 * memory areas, the procedure copies string, and it's expected that output
 * memory is at least as big as the input. It's also possible to set input equal
 * output, that makes replacements an in-place operation.
 *
 * @param input the UTF-16 string to correct.
 * @param len the length of the string in number of 2-byte code units
 * (char16_t).
 * @param output the output buffer.
 */
void to_well_formed_utf16(const char16_t *input, size_t len,
                          char16_t *output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 void
to_well_formed_utf16(std::span<const char16_t> input,
                     std::span<char16_t> output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    scalar::utf16::to_well_formed_utf16<endianness::NATIVE>(
        input.data(), input.size(), output.data());
  } else
    #endif
  {
    to_well_formed_utf16(input.data(), input.size(), output.data());
  }
}
  #endif // SIMDUTF_SPAN

#endif // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF32 || SIMDUTF_FEATURE_DETECT_ENCODING
/**
 * Validate the UTF-32 string. This function may be best when you expect
 * the input to be almost always valid. Otherwise, consider using
 * validate_utf32_with_errors.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-32 string to validate.
 * @param len the length of the string in number of 4-byte code units
 * (char32_t).
 * @return true if and only if the string is valid UTF-32.
 */
simdutf_warn_unused bool validate_utf32(const char32_t *buf,
                                        size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 bool
validate_utf32(std::span<const char32_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32::validate(
        detail::constexpr_cast_ptr<std::uint32_t>(input.data()), input.size());
  } else
    #endif
  {
    return validate_utf32(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF32 || SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_UTF32
/**
 * Validate the UTF-32 string and stop on error. It might be faster than
 * validate_utf32 when an error is expected to occur early.
 *
 * Overridden by each implementation.
 *
 * This function is not BOM-aware.
 *
 * @param buf the UTF-32 string to validate.
 * @param len the length of the string in number of 4-byte code units
 * (char32_t).
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of code units validated if
 * successful.
 */
simdutf_warn_unused result validate_utf32_with_errors(const char32_t *buf,
                                                      size_t len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
validate_utf32_with_errors(std::span<const char32_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32::validate_with_errors(
        detail::constexpr_cast_ptr<std::uint32_t>(input.data()), input.size());
  } else
    #endif
  {
    return validate_utf32_with_errors(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
/**
 * Convert Latin1 string into UTF-8 string.
 *
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the Latin1 string to convert
 * @param length        the length of the string in bytes
 * @param utf8_output   the pointer to buffer that can hold conversion result
 * @return the number of written char; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_latin1_to_utf8(const char *input,
                                                  size_t length,
                                                  char *utf8_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_latin1_to_utf8(
    const detail::input_span_of_byte_like auto &latin1_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::latin1_to_utf8::convert(
        detail::constexpr_cast_ptr<char>(latin1_input.data()),
        latin1_input.size(),
        detail::constexpr_cast_writeptr<char>(utf8_output.data()));
  } else
    #endif
  {
    return convert_latin1_to_utf8(
        reinterpret_cast<const char *>(latin1_input.data()),
        latin1_input.size(), reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert Latin1 string into UTF-8 string with output limit.
 *
 * This function is suitable to work with inputs from untrusted sources.
 *
 * We write as many characters as possible.
 *
 * @param input         the Latin1 string to convert
 * @param length        the length of the string in bytes
 * @param utf8_output  	the pointer to buffer that can hold conversion result
 * @param utf8_len      the maximum output length
 * @return the number of written char; 0 if conversion is not possible
 */
simdutf_warn_unused size_t
convert_latin1_to_utf8_safe(const char *input, size_t length, char *utf8_output,
                            size_t utf8_len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_latin1_to_utf8_safe(
    const detail::input_span_of_byte_like auto &input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
      // implementation note: outputspan is a forwarding ref to avoid copying
      // and allow both lvalues and rvalues. std::span can be copied without
      // problems, but std::vector should not, and this function should accept
      // both. it will allow using an owning rvalue ref (example: passing a
      // temporary std::string) as output, but the user will quickly find out
      // that he has no way of getting the data out of the object in that case.
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::latin1_to_utf8::convert_safe_constexpr(
        input.data(), input.size(), utf8_output.data(), utf8_output.size());
  } else
    #endif
  {
    return convert_latin1_to_utf8_safe(
        reinterpret_cast<const char *>(input.data()), input.size(),
        reinterpret_cast<char *>(utf8_output.data()), utf8_output.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
/**
 * Convert possibly Latin1 string into UTF-16LE string.
 *
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the Latin1 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_latin1_to_utf16le(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_latin1_to_utf16le(
    const detail::input_span_of_byte_like auto &latin1_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::latin1_to_utf16::convert<endianness::LITTLE>(
        latin1_input.data(), latin1_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_latin1_to_utf16le(
        reinterpret_cast<const char *>(latin1_input.data()),
        latin1_input.size(), utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert Latin1 string into UTF-16BE string.
 *
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the Latin1 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_latin1_to_utf16be(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_latin1_to_utf16be(const detail::input_span_of_byte_like auto &input,
                          std::span<char16_t> output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::latin1_to_utf16::convert<endianness::BIG>(
        input.data(), input.size(), output.data());
  } else
    #endif
  {
    return convert_latin1_to_utf16be(
        reinterpret_cast<const char *>(input.data()), input.size(),
        output.data());
  }
}
  #endif // SIMDUTF_SPAN
/**
 * Compute the number of bytes that this UTF-16 string would require in Latin1
 * format.
 *
 * @param length        the length of the string in Latin1 code units (char)
 * @return the length of the string in Latin1 code units (char) required to
 * encode the UTF-16 string as Latin1
 */
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
latin1_length_from_utf16(size_t length) noexcept {
  return length;
}

/**
 * Compute the number of code units that this Latin1 string would require in
 * UTF-16 format.
 *
 * @param length        the length of the string in Latin1 code units (char)
 * @return the length of the string in 2-byte code units (char16_t) required to
 * encode the Latin1 string as UTF-16
 */
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf16_length_from_latin1(size_t length) noexcept {
  return length;
}
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1
/**
 * Convert Latin1 string into UTF-32 string.
 *
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the Latin1 string to convert
 * @param length        the length of the string in bytes
 * @param utf32_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char32_t; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_latin1_to_utf32(
    const char *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_latin1_to_utf32(
    const detail::input_span_of_byte_like auto &latin1_input,
    std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::latin1_to_utf32::convert(
        latin1_input.data(), latin1_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_latin1_to_utf32(
        reinterpret_cast<const char *>(latin1_input.data()),
        latin1_input.size(), utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
/**
 * Convert possibly broken UTF-8 string into latin1 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param latin1_output  the pointer to buffer that can hold conversion result
 * @return the number of written char; 0 if the input was not valid UTF-8 string
 * or if it cannot be represented as Latin1
 */
simdutf_warn_unused size_t convert_utf8_to_latin1(const char *input,
                                                  size_t length,
                                                  char *latin1_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf8_to_latin1(
    const detail::input_span_of_byte_like auto &input,
    detail::output_span_of_byte_like auto &&output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_latin1::convert(input.data(), input.size(),
                                           output.data());
  } else
    #endif
  {
    return convert_utf8_to_latin1(reinterpret_cast<const char *>(input.data()),
                                  input.size(),
                                  reinterpret_cast<char *>(output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness, convert possibly broken UTF-8 string into a UTF-16
 * string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t; 0 if the input was not valid UTF-8
 * string
 */
simdutf_warn_unused size_t convert_utf8_to_utf16(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf8_to_utf16(const detail::input_span_of_byte_like auto &input,
                      std::span<char16_t> output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert<endianness::NATIVE>(
        input.data(), input.size(), output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf16(reinterpret_cast<const char *>(input.data()),
                                 input.size(), output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-16LE string would require in UTF-8
 * format even when the UTF-16LE content contains mismatched surrogates
 * that have to be replaced by the replacement character (0xFFFD).
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) where the count is the number of bytes required to
 * encode the UTF-16LE string as UTF-8, and the error code is either SUCCESS or
 * SURROGATE. The count is correct regardless of the error field.
 * When SURROGATE is returned, it does not indicate an error in the case of this
 * function: it indicates that at least one surrogate has been encountered: the
 * surrogates may be matched or not (thus this function does not validate). If
 * the returned error code is SUCCESS, then the input contains no surrogate, is
 * in the Basic Multilingual Plane, and is necessarily valid.
 */
simdutf_warn_unused result utf8_length_from_utf16le_with_replacement(
    const char16_t *input, size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 simdutf_warn_unused result
utf8_length_from_utf16le_with_replacement(
    std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf8_length_from_utf16_with_replacement<
        endianness::LITTLE>(valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf8_length_from_utf16le_with_replacement(valid_utf16_input.data(),
                                                     valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-16BE string would require in UTF-8
 * format even when the UTF-16BE content contains mismatched surrogates
 * that have to be replaced by the replacement character (0xFFFD).
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) where the count is the number of bytes required to
 * encode the UTF-16BE string as UTF-8, and the error code is either SUCCESS or
 * SURROGATE. The count is correct regardless of the error field.
 * When SURROGATE is returned, it does not indicate an error in the case of this
 * function: it indicates that at least one surrogate has been encountered: the
 * surrogates may be matched or not (thus this function does not validate). If
 * the returned error code is SUCCESS, then the input contains no surrogate, is
 * in the Basic Multilingual Plane, and is necessarily valid.
 */
simdutf_warn_unused result utf8_length_from_utf16be_with_replacement(
    const char16_t *input, size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
utf8_length_from_utf16be_with_replacement(
    std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf8_length_from_utf16_with_replacement<
        endianness::BIG>(valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf8_length_from_utf16be_with_replacement(valid_utf16_input.data(),
                                                     valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
/**
 * Using native endianness, convert a Latin1 string into a UTF-16 string.
 *
 * @param input         the Latin1 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t.
 */
simdutf_warn_unused size_t convert_latin1_to_utf16(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_latin1_to_utf16(const detail::input_span_of_byte_like auto &input,
                        std::span<char16_t> output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::latin1_to_utf16::convert<endianness::NATIVE>(
        input.data(), input.size(), output.data());
  } else
    #endif
  {
    return convert_latin1_to_utf16(reinterpret_cast<const char *>(input.data()),
                                   input.size(), output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Convert possibly broken UTF-8 string into UTF-16LE string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t; 0 if the input was not valid UTF-8
 * string
 */
simdutf_warn_unused size_t convert_utf8_to_utf16le(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf8_to_utf16le(const detail::input_span_of_byte_like auto &utf8_input,
                        std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert<endianness::LITTLE>(
        utf8_input.data(), utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf16le(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-8 string into UTF-16BE string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t; 0 if the input was not valid UTF-8
 * string
 */
simdutf_warn_unused size_t convert_utf8_to_utf16be(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf8_to_utf16be(const detail::input_span_of_byte_like auto &utf8_input,
                        std::span<char16_t> utf16_output) noexcept {

    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert<endianness::BIG>(
        utf8_input.data(), utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf16be(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
/**
 * Convert possibly broken UTF-8 string into latin1 string with errors.
 * If the string cannot be represented as Latin1, an error
 * code is returned.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param latin1_output  the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of code units validated if
 * successful.
 */
simdutf_warn_unused result convert_utf8_to_latin1_with_errors(
    const char *input, size_t length, char *latin1_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf8_to_latin1_with_errors(
    const detail::input_span_of_byte_like auto &utf8_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_latin1::convert_with_errors(
        utf8_input.data(), utf8_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf8_to_latin1_with_errors(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness, convert possibly broken UTF-8 string into UTF-16
 * string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char16_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf8_to_utf16_with_errors(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf8_to_utf16_with_errors(
    const detail::input_span_of_byte_like auto &utf8_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert_with_errors<endianness::NATIVE>(
        utf8_input.data(), utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf16_with_errors(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-8 string into UTF-16LE string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char16_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf8_to_utf16le_with_errors(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf8_to_utf16le_with_errors(
    const detail::input_span_of_byte_like auto &utf8_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert_with_errors<endianness::LITTLE>(
        utf8_input.data(), utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf16le_with_errors(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-8 string into UTF-16BE string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char16_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf8_to_utf16be_with_errors(
    const char *input, size_t length, char16_t *utf16_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf8_to_utf16be_with_errors(
    const detail::input_span_of_byte_like auto &utf8_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert_with_errors<endianness::BIG>(
        utf8_input.data(), utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf16be_with_errors(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
/**
 * Convert possibly broken UTF-8 string into UTF-32 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf32_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char32_t; 0 if the input was not valid UTF-8
 * string
 */
simdutf_warn_unused size_t convert_utf8_to_utf32(
    const char *input, size_t length, char32_t *utf32_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf8_to_utf32(const detail::input_span_of_byte_like auto &utf8_input,
                      std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf32::convert(utf8_input.data(), utf8_input.size(),
                                          utf32_output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf32(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-8 string into UTF-32 string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf32_buffer  the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char32_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf8_to_utf32_with_errors(
    const char *input, size_t length, char32_t *utf32_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf8_to_utf32_with_errors(
    const detail::input_span_of_byte_like auto &utf8_input,
    std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf32::convert_with_errors(
        utf8_input.data(), utf8_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_utf8_to_utf32_with_errors(
        reinterpret_cast<const char *>(utf8_input.data()), utf8_input.size(),
        utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
/**
 * Convert valid UTF-8 string into latin1 string.
 *
 * This function assumes that the input string is valid UTF-8 and that it can be
 * represented as Latin1. If you violate this assumption, the result is
 * implementation defined and may include system-dependent behavior such as
 * crashes.
 *
 * This function is for expert users only and not part of our public API. Use
 * convert_utf8_to_latin1 instead. The function may be removed from the library
 * in the future.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param latin1_output  the pointer to buffer that can hold conversion result
 * @return the number of written char; 0 if the input was not valid UTF-8 string
 */
simdutf_warn_unused size_t convert_valid_utf8_to_latin1(
    const char *input, size_t length, char *latin1_output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf8_to_latin1(
    const detail::input_span_of_byte_like auto &valid_utf8_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_latin1::convert_valid(
        valid_utf8_input.data(), valid_utf8_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_valid_utf8_to_latin1(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size(), latin1_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness, convert valid UTF-8 string into a UTF-16 string.
 *
 * This function assumes that the input string is valid UTF-8.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t
 */
simdutf_warn_unused size_t convert_valid_utf8_to_utf16(
    const char *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf8_to_utf16(
    const detail::input_span_of_byte_like auto &valid_utf8_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert_valid<endianness::NATIVE>(
        valid_utf8_input.data(), valid_utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_valid_utf8_to_utf16(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size(), utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-8 string into UTF-16LE string.
 *
 * This function assumes that the input string is valid UTF-8.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t
 */
simdutf_warn_unused size_t convert_valid_utf8_to_utf16le(
    const char *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf8_to_utf16le(
    const detail::input_span_of_byte_like auto &valid_utf8_input,
    std::span<char16_t> utf16_output) noexcept {

    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert_valid<endianness::LITTLE>(
        valid_utf8_input.data(), valid_utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_valid_utf8_to_utf16le(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size(), utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-8 string into UTF-16BE string.
 *
 * This function assumes that the input string is valid UTF-8.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf16_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char16_t
 */
simdutf_warn_unused size_t convert_valid_utf8_to_utf16be(
    const char *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf8_to_utf16be(
    const detail::input_span_of_byte_like auto &valid_utf8_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf16::convert_valid<endianness::BIG>(
        valid_utf8_input.data(), valid_utf8_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_valid_utf8_to_utf16be(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size(), utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
/**
 * Convert valid UTF-8 string into UTF-32 string.
 *
 * This function assumes that the input string is valid UTF-8.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in bytes
 * @param utf32_buffer  the pointer to buffer that can hold conversion result
 * @return the number of written char32_t
 */
simdutf_warn_unused size_t convert_valid_utf8_to_utf32(
    const char *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf8_to_utf32(
    const detail::input_span_of_byte_like auto &valid_utf8_input,
    std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8_to_utf32::convert_valid(
        valid_utf8_input.data(), valid_utf8_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_valid_utf8_to_utf32(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size(), utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
/**
 * Return the number of bytes that this Latin1 string would require in UTF-8
 * format.
 *
 * @param input         the Latin1 string to convert
 * @param length        the length of the string bytes
 * @return the number of bytes required to encode the Latin1 string as UTF-8
 */
simdutf_warn_unused size_t utf8_length_from_latin1(const char *input,
                                                   size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf8_length_from_latin1(
    const detail::input_span_of_byte_like auto &latin1_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::latin1_to_utf8::utf8_length_from_latin1(latin1_input.data(),
                                                           latin1_input.size());
  } else
    #endif
  {
    return utf8_length_from_latin1(
        reinterpret_cast<const char *>(latin1_input.data()),
        latin1_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-8 string would require in Latin1
 * format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-8 strings but in such cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-8 string to convert
 * @param length        the length of the string in byte
 * @return the number of bytes required to encode the UTF-8 string as Latin1
 */
simdutf_warn_unused size_t latin1_length_from_utf8(const char *input,
                                                   size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
latin1_length_from_utf8(
    const detail::input_span_of_byte_like auto &valid_utf8_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8::count_code_points(valid_utf8_input.data(),
                                           valid_utf8_input.size());
  } else
    #endif
  {
    return latin1_length_from_utf8(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Compute the number of 2-byte code units that this UTF-8 string would require
 * in UTF-16LE format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-8 strings but in such cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-8 string to process
 * @param length        the length of the string in bytes
 * @return the number of char16_t code units required to encode the UTF-8 string
 * as UTF-16LE
 */
simdutf_warn_unused size_t utf16_length_from_utf8(const char *input,
                                                  size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf16_length_from_utf8(
    const detail::input_span_of_byte_like auto &valid_utf8_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8::utf16_length_from_utf8(valid_utf8_input.data(),
                                                valid_utf8_input.size());
  } else
    #endif
  {
    return utf16_length_from_utf8(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
/**
 * Compute the number of 4-byte code units that this UTF-8 string would require
 * in UTF-32 format.
 *
 * This function is equivalent to count_utf8
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-8 strings but in such cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-8 string to process
 * @param length        the length of the string in bytes
 * @return the number of char32_t code units required to encode the UTF-8 string
 * as UTF-32
 */
simdutf_warn_unused size_t utf32_length_from_utf8(const char *input,
                                                  size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf32_length_from_utf8(
    const detail::input_span_of_byte_like auto &valid_utf8_input) noexcept {

    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8::count_code_points(valid_utf8_input.data(),
                                           valid_utf8_input.size());
  } else
    #endif
  {
    return utf32_length_from_utf8(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness, convert possibly broken UTF-16 string into UTF-8
 * string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16LE
 * string
 */
simdutf_warn_unused size_t convert_utf16_to_utf8(const char16_t *input,
                                                 size_t length,
                                                 char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16_to_utf8(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert<endianness::NATIVE>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16_to_utf8(utf16_input.data(), utf16_input.size(),
                                 reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness, convert possibly broken UTF-16 string into UTF-8
 * string with output limit.
 *
 * We write as many characters as possible into the output buffer,
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 16-bit code units (char16_t)
 * @param utf8_output  	the pointer to buffer that can hold conversion result
 * @param utf8_len      the maximum output length
 * @return the number of written char; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_utf16_to_utf8_safe(const char16_t *input,
                                                      size_t length,
                                                      char *utf8_output,
                                                      size_t utf8_len) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16_to_utf8_safe(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
      // implementation note: outputspan is a forwarding ref to avoid copying
      // and allow both lvalues and rvalues. std::span can be copied without
      // problems, but std::vector should not, and this function should accept
      // both. it will allow using an owning rvalue ref (example: passing a
      // temporary std::string) as output, but the user will quickly find out
      // that he has no way of getting the data out of the object in that case.
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    const full_result r =
        scalar::utf16_to_utf8::convert_with_errors<endianness::NATIVE, true>(
            utf16_input.data(), utf16_input.size(), utf8_output.data(),
            utf8_output.size());
    if (r.error != error_code::SUCCESS &&
        r.error != error_code::OUTPUT_BUFFER_TOO_SMALL) {
      return 0;
    }
    return r.output_count;
  } else
    #endif
  {
    return convert_utf16_to_utf8_safe(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()), utf8_output.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
/**
 * Using native endianness, convert possibly broken UTF-16 string into Latin1
 * string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16 string
 * or if it cannot be represented as Latin1
 */
simdutf_warn_unused size_t convert_utf16_to_latin1(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16_to_latin1(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert<endianness::NATIVE>(
        utf16_input.data(), utf16_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf16_to_latin1(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16LE string into Latin1 string.
 * If the string cannot be represented as Latin1, an error
 * is returned.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16LE
 * string or if it cannot be represented as Latin1
 */
simdutf_warn_unused size_t convert_utf16le_to_latin1(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16le_to_latin1(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert<endianness::LITTLE>(
        utf16_input.data(), utf16_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf16le_to_latin1(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16BE string into Latin1 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16BE
 * string or if it cannot be represented as Latin1
 */
simdutf_warn_unused size_t convert_utf16be_to_latin1(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16be_to_latin1(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert<endianness::BIG>(
        utf16_input.data(), utf16_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf16be_to_latin1(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Convert possibly broken UTF-16LE string into UTF-8 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16LE
 * string
 */
simdutf_warn_unused size_t convert_utf16le_to_utf8(const char16_t *input,
                                                   size_t length,
                                                   char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16le_to_utf8(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert<endianness::LITTLE>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16le_to_utf8(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16BE string into UTF-8 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16LE
 * string
 */
simdutf_warn_unused size_t convert_utf16be_to_utf8(const char16_t *input,
                                                   size_t length,
                                                   char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16be_to_utf8(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert<endianness::BIG>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16be_to_utf8(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
/**
 * Using native endianness, convert possibly broken UTF-16 string into Latin1
 * string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf16_to_latin1_with_errors(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16_to_latin1_with_errors(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert_with_errors<endianness::NATIVE>(
        utf16_input.data(), utf16_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf16_to_latin1_with_errors(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16LE string into Latin1 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf16le_to_latin1_with_errors(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16le_to_latin1_with_errors(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert_with_errors<endianness::LITTLE>(
        utf16_input.data(), utf16_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf16le_to_latin1_with_errors(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16BE string into Latin1 string.
 * If the string cannot be represented as Latin1, an error
 * is returned.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf16be_to_latin1_with_errors(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16be_to_latin1_with_errors(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert_with_errors<endianness::BIG>(
        utf16_input.data(), utf16_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf16be_to_latin1_with_errors(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness, convert possibly broken UTF-16 string into UTF-8
 * string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf16_to_utf8_with_errors(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16_to_utf8_with_errors(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_with_errors<endianness::NATIVE>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16_to_utf8_with_errors(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16LE string into UTF-8 string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf16le_to_utf8_with_errors(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16le_to_utf8_with_errors(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_with_errors<endianness::LITTLE>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16le_to_utf8_with_errors(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16BE string into UTF-8 string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf16be_to_utf8_with_errors(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16be_to_utf8_with_errors(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_with_errors<endianness::BIG>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16be_to_utf8_with_errors(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16LE string into UTF-8 string, replacing
 * unpaired surrogates with the Unicode replacement character U+FFFD.
 *
 * This function always succeeds: unpaired surrogates are replaced with
 * U+FFFD (3 bytes in UTF-8: 0xEF 0xBF 0xBD).
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units
 */
simdutf_warn_unused size_t convert_utf16le_to_utf8_with_replacement(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16le_to_utf8_with_replacement(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_with_replacement<endianness::LITTLE>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16le_to_utf8_with_replacement(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16BE string into UTF-8 string, replacing
 * unpaired surrogates with the Unicode replacement character U+FFFD.
 *
 * This function always succeeds: unpaired surrogates are replaced with
 * U+FFFD (3 bytes in UTF-8: 0xEF 0xBF 0xBD).
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units
 */
simdutf_warn_unused size_t convert_utf16be_to_utf8_with_replacement(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16be_to_utf8_with_replacement(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_with_replacement<endianness::BIG>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16be_to_utf8_with_replacement(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16 string (native endianness) into UTF-8 string,
 * replacing unpaired surrogates with the Unicode replacement character U+FFFD.
 *
 * This function always succeeds: unpaired surrogates are replaced with
 * U+FFFD (3 bytes in UTF-8: 0xEF 0xBF 0xBD).
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units
 */
simdutf_warn_unused size_t convert_utf16_to_utf8_with_replacement(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16_to_utf8_with_replacement(
    std::span<const char16_t> utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_with_replacement<endianness::NATIVE>(
        utf16_input.data(), utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf16_to_utf8_with_replacement(
        utf16_input.data(), utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness, convert valid UTF-16 string into UTF-8 string.
 *
 * This function assumes that the input string is valid UTF-16.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16_to_utf8(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf16_to_utf8(
    std::span<const char16_t> valid_utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_valid<endianness::NATIVE>(
        valid_utf16_input.data(), valid_utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_valid_utf16_to_utf8(
        valid_utf16_input.data(), valid_utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
/**
 * Using native endianness, convert UTF-16 string into Latin1 string.
 *
 * This function assumes that the input string is valid UTF-16 and that it can
 * be represented as Latin1. If you violate this assumption, the result is
 * implementation defined and may include system-dependent behavior such as
 * crashes.
 *
 * This function is for expert users only and not part of our public API. Use
 * convert_utf16_to_latin1 instead. The function may be removed from the library
 * in the future.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16_to_latin1(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf16_to_latin1(
    std::span<const char16_t> valid_utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert_valid_impl<endianness::NATIVE>(
        detail::constexpr_cast_ptr<uint16_t>(valid_utf16_input.data()),
        valid_utf16_input.size(),
        detail::constexpr_cast_writeptr<char>(latin1_output.data()));
  } else
    #endif
  {
    return convert_valid_utf16_to_latin1(
        valid_utf16_input.data(), valid_utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-16LE string into Latin1 string.
 *
 * This function assumes that the input string is valid UTF-16LE and that it can
 * be represented as Latin1. If you violate this assumption, the result is
 * implementation defined and may include system-dependent behavior such as
 * crashes.
 *
 * This function is for expert users only and not part of our public API. Use
 * convert_utf16le_to_latin1 instead. The function may be removed from the
 * library in the future.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16le_to_latin1(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 simdutf_warn_unused size_t
convert_valid_utf16le_to_latin1(
    std::span<const char16_t> valid_utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert_valid_impl<endianness::LITTLE>(
        detail::constexpr_cast_ptr<uint16_t>(valid_utf16_input.data()),
        valid_utf16_input.size(),
        detail::constexpr_cast_writeptr<char>(latin1_output.data()));
  } else
    #endif
  {
    return convert_valid_utf16le_to_latin1(
        valid_utf16_input.data(), valid_utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-16BE string into Latin1 string.
 *
 * This function assumes that the input string is valid UTF-16BE and that it can
 * be represented as Latin1. If you violate this assumption, the result is
 * implementation defined and may include system-dependent behavior such as
 * crashes.
 *
 * This function is for expert users only and not part of our public API. Use
 * convert_utf16be_to_latin1 instead. The function may be removed from the
 * library in the future.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16be_to_latin1(
    const char16_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 simdutf_warn_unused size_t
convert_valid_utf16be_to_latin1(
    std::span<const char16_t> valid_utf16_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_latin1::convert_valid_impl<endianness::BIG>(
        detail::constexpr_cast_ptr<uint16_t>(valid_utf16_input.data()),
        valid_utf16_input.size(),
        detail::constexpr_cast_writeptr<char>(latin1_output.data()));
  } else
    #endif
  {
    return convert_valid_utf16be_to_latin1(
        valid_utf16_input.data(), valid_utf16_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Convert valid UTF-16LE string into UTF-8 string.
 *
 * This function assumes that the input string is valid UTF-16LE
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16le_to_utf8(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf16le_to_utf8(
    std::span<const char16_t> valid_utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_valid<endianness::NATIVE>(
        valid_utf16_input.data(), valid_utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_valid_utf16le_to_utf8(
        valid_utf16_input.data(), valid_utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-16BE string into UTF-8 string.
 *
 * This function assumes that the input string is valid UTF-16BE.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf8_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16be_to_utf8(
    const char16_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf16be_to_utf8(
    std::span<const char16_t> valid_utf16_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf8::convert_valid<endianness::BIG>(
        valid_utf16_input.data(), valid_utf16_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_valid_utf16be_to_utf8(
        valid_utf16_input.data(), valid_utf16_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
/**
 * Using native endianness, convert possibly broken UTF-16 string into UTF-32
 * string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16LE
 * string
 */
simdutf_warn_unused size_t convert_utf16_to_utf32(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16_to_utf32(std::span<const char16_t> utf16_input,
                       std::span<char32_t> utf32_output) noexcept {

    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert<endianness::NATIVE>(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_utf16_to_utf32(utf16_input.data(), utf16_input.size(),
                                  utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16LE string into UTF-32 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16LE
 * string
 */
simdutf_warn_unused size_t convert_utf16le_to_utf32(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16le_to_utf32(std::span<const char16_t> utf16_input,
                         std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert<endianness::LITTLE>(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_utf16le_to_utf32(utf16_input.data(), utf16_input.size(),
                                    utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16BE string into UTF-32 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-16LE
 * string
 */
simdutf_warn_unused size_t convert_utf16be_to_utf32(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf16be_to_utf32(std::span<const char16_t> utf16_input,
                         std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert<endianness::BIG>(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_utf16be_to_utf32(utf16_input.data(), utf16_input.size(),
                                    utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness, convert possibly broken UTF-16 string into
 * UTF-32 string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char32_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf16_to_utf32_with_errors(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16_to_utf32_with_errors(std::span<const char16_t> utf16_input,
                                   std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert_with_errors<endianness::NATIVE>(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_utf16_to_utf32_with_errors(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16LE string into UTF-32 string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char32_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf16le_to_utf32_with_errors(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16le_to_utf32_with_errors(
    std::span<const char16_t> utf16_input,
    std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert_with_errors<endianness::LITTLE>(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_utf16le_to_utf32_with_errors(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-16BE string into UTF-32 string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char32_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf16be_to_utf32_with_errors(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf16be_to_utf32_with_errors(
    std::span<const char16_t> utf16_input,
    std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert_with_errors<endianness::BIG>(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  } else
    #endif
  {
    return convert_utf16be_to_utf32_with_errors(
        utf16_input.data(), utf16_input.size(), utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness, convert valid UTF-16 string into UTF-32 string.
 *
 * This function assumes that the input string is valid UTF-16 (native
 * endianness).
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16_to_utf32(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf16_to_utf32(std::span<const char16_t> valid_utf16_input,
                             std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert_valid<endianness::NATIVE>(
        valid_utf16_input.data(), valid_utf16_input.size(),
        utf32_output.data());
  } else
    #endif
  {
    return convert_valid_utf16_to_utf32(valid_utf16_input.data(),
                                        valid_utf16_input.size(),
                                        utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-16LE string into UTF-32 string.
 *
 * This function assumes that the input string is valid UTF-16LE.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16le_to_utf32(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf16le_to_utf32(std::span<const char16_t> valid_utf16_input,
                               std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert_valid<endianness::LITTLE>(
        valid_utf16_input.data(), valid_utf16_input.size(),
        utf32_output.data());
  } else
    #endif
  {
    return convert_valid_utf16le_to_utf32(valid_utf16_input.data(),
                                          valid_utf16_input.size(),
                                          utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-16BE string into UTF-32 string.
 *
 * This function assumes that the input string is valid UTF-16LE.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param utf32_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf16be_to_utf32(
    const char16_t *input, size_t length, char32_t *utf32_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf16be_to_utf32(std::span<const char16_t> valid_utf16_input,
                               std::span<char32_t> utf32_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16_to_utf32::convert_valid<endianness::BIG>(
        valid_utf16_input.data(), valid_utf16_input.size(),
        utf32_output.data());
  } else
    #endif
  {
    return convert_valid_utf16be_to_utf32(valid_utf16_input.data(),
                                          valid_utf16_input.size(),
                                          utf32_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
/**
 * Using native endianness; Compute the number of bytes that this UTF-16
 * string would require in UTF-8 format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-16 strings but in such cases the result is implementation defined.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return the number of bytes required to encode the UTF-16LE string as UTF-8
 */
simdutf_warn_unused size_t utf8_length_from_utf16(const char16_t *input,
                                                  size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf8_length_from_utf16(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf8_length_from_utf16<endianness::NATIVE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf8_length_from_utf16(valid_utf16_input.data(),
                                  valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness; compute the number of bytes that this UTF-16
 * string would require in UTF-8 format even when the UTF-16LE content contains
 * mismatched surrogates that have to be replaced by the replacement character
 * (0xFFFD).
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) where the count is the number of bytes required to
 * encode the UTF-16 string as UTF-8, and the error code is either SUCCESS or
 * SURROGATE. The count is correct regardless of the error field.
 * When SURROGATE is returned, it does not indicate an error in the case of this
 * function: it indicates that at least one surrogate has been encountered: the
 * surrogates may be matched or not (thus this function does not validate). If
 * the returned error code is SUCCESS, then the input contains no surrogate, is
 * in the Basic Multilingual Plane, and is necessarily valid.
 */
simdutf_warn_unused result utf8_length_from_utf16_with_replacement(
    const char16_t *input, size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
utf8_length_from_utf16_with_replacement(
    std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf8_length_from_utf16_with_replacement<
        endianness::NATIVE>(valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf8_length_from_utf16_with_replacement(valid_utf16_input.data(),
                                                   valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-16LE string would require in UTF-8
 * format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-16 strings but in such cases the result is implementation defined.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return the number of bytes required to encode the UTF-16LE string as UTF-8
 */
simdutf_warn_unused size_t utf8_length_from_utf16le(const char16_t *input,
                                                    size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 simdutf_warn_unused size_t
utf8_length_from_utf16le(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf8_length_from_utf16<endianness::LITTLE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf8_length_from_utf16le(valid_utf16_input.data(),
                                    valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-16BE string would require in UTF-8
 * format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-16 strings but in such cases the result is implementation defined.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return the number of bytes required to encode the UTF-16BE string as UTF-8
 */
simdutf_warn_unused size_t utf8_length_from_utf16be(const char16_t *input,
                                                    size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf8_length_from_utf16be(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf8_length_from_utf16<endianness::BIG>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf8_length_from_utf16be(valid_utf16_input.data(),
                                    valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
/**
 * Convert possibly broken UTF-32 string into UTF-8 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-32 string
 */
simdutf_warn_unused size_t convert_utf32_to_utf8(const char32_t *input,
                                                 size_t length,
                                                 char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf32_to_utf8(
    std::span<const char32_t> utf32_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf8::convert(
        utf32_input.data(), utf32_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf8(utf32_input.data(), utf32_input.size(),
                                 reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-32 string into UTF-8 string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf8_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf32_to_utf8_with_errors(
    const char32_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf32_to_utf8_with_errors(
    std::span<const char32_t> utf32_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf8::convert_with_errors(
        utf32_input.data(), utf32_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf8_with_errors(
        utf32_input.data(), utf32_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-32 string into UTF-8 string.
 *
 * This function assumes that the input string is valid UTF-32.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf8_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf32_to_utf8(
    const char32_t *input, size_t length, char *utf8_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf32_to_utf8(
    std::span<const char32_t> valid_utf32_input,
    detail::output_span_of_byte_like auto &&utf8_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf8::convert_valid(
        valid_utf32_input.data(), valid_utf32_input.size(), utf8_output.data());
  } else
    #endif
  {
    return convert_valid_utf32_to_utf8(
        valid_utf32_input.data(), valid_utf32_input.size(),
        reinterpret_cast<char *>(utf8_output.data()));
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
/**
 * Using native endianness, convert possibly broken UTF-32 string into a UTF-16
 * string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-32 string
 */
simdutf_warn_unused size_t convert_utf32_to_utf16(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf32_to_utf16(std::span<const char32_t> utf32_input,
                       std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert<endianness::NATIVE>(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf16(utf32_input.data(), utf32_input.size(),
                                  utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-32 string into UTF-16LE string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-32 string
 */
simdutf_warn_unused size_t convert_utf32_to_utf16le(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf32_to_utf16le(std::span<const char32_t> utf32_input,
                         std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert<endianness::LITTLE>(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf16le(utf32_input.data(), utf32_input.size(),
                                    utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1
/**
 * Convert possibly broken UTF-32 string into Latin1 string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-32 string
 * or if it cannot be represented as Latin1
 */
simdutf_warn_unused size_t convert_utf32_to_latin1(
    const char32_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf32_to_latin1(
    std::span<const char32_t> utf32_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_latin1::convert(
        utf32_input.data(), utf32_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf32_to_latin1(
        utf32_input.data(), utf32_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-32 string into Latin1 string and stop on error.
 * If the string cannot be represented as Latin1, an error is returned.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param latin1_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char written if
 * successful.
 */
simdutf_warn_unused result convert_utf32_to_latin1_with_errors(
    const char32_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf32_to_latin1_with_errors(
    std::span<const char32_t> utf32_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_latin1::convert_with_errors(
        utf32_input.data(), utf32_input.size(), latin1_output.data());
  } else
    #endif
  {
    return convert_utf32_to_latin1_with_errors(
        utf32_input.data(), utf32_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-32 string into Latin1 string.
 *
 * This function assumes that the input string is valid UTF-32 and that it can
 * be represented as Latin1. If you violate this assumption, the result is
 * implementation defined and may include system-dependent behavior such as
 * crashes.
 *
 * This function is for expert users only and not part of our public API. Use
 * convert_utf32_to_latin1 instead. The function may be removed from the library
 * in the future.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param latin1_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf32_to_latin1(
    const char32_t *input, size_t length, char *latin1_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 simdutf_warn_unused size_t
convert_valid_utf32_to_latin1(
    std::span<const char32_t> valid_utf32_input,
    detail::output_span_of_byte_like auto &&latin1_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_latin1::convert_valid(
        detail::constexpr_cast_ptr<uint32_t>(valid_utf32_input.data()),
        valid_utf32_input.size(),
        detail::constexpr_cast_writeptr<char>(latin1_output.data()));
  }
    #endif
  {
    return convert_valid_utf32_to_latin1(
        valid_utf32_input.data(), valid_utf32_input.size(),
        reinterpret_cast<char *>(latin1_output.data()));
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-32 string would require in Latin1
 * format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-32 strings but in such cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @return the number of bytes required to encode the UTF-32 string as Latin1
 */
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 size_t
latin1_length_from_utf32(size_t length) noexcept {
  return length;
}

/**
 * Compute the number of bytes that this Latin1 string would require in UTF-32
 * format.
 *
 * @param length        the length of the string in Latin1 code units (char)
 * @return the length of the string in 4-byte code units (char32_t) required to
 * encode the Latin1 string as UTF-32
 */
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 size_t
utf32_length_from_latin1(size_t length) noexcept {
  return length;
}
#endif // SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
/**
 * Convert possibly broken UTF-32 string into UTF-16BE string.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to buffer that can hold conversion result
 * @return number of written code units; 0 if input is not a valid UTF-32 string
 */
simdutf_warn_unused size_t convert_utf32_to_utf16be(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_utf32_to_utf16be(std::span<const char32_t> utf32_input,
                         std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert<endianness::BIG>(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf16be(utf32_input.data(), utf32_input.size(),
                                    utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness, convert possibly broken UTF-32 string into UTF-16
 * string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char16_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf32_to_utf16_with_errors(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf32_to_utf16_with_errors(std::span<const char32_t> utf32_input,
                                   std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert_with_errors<endianness::NATIVE>(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf16_with_errors(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-32 string into UTF-16LE string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char16_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf32_to_utf16le_with_errors(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf32_to_utf16le_with_errors(
    std::span<const char32_t> utf32_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert_with_errors<endianness::LITTLE>(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf16le_with_errors(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert possibly broken UTF-32 string into UTF-16BE string and stop on error.
 *
 * During the conversion also validation of the input string is done.
 * This function is suitable to work with inputs from untrusted sources.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to buffer that can hold conversion result
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in code units) if any, or the number of char16_t written if
 * successful.
 */
simdutf_warn_unused result convert_utf32_to_utf16be_with_errors(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
convert_utf32_to_utf16be_with_errors(
    std::span<const char32_t> utf32_input,
    std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert_with_errors<endianness::BIG>(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  } else
    #endif
  {
    return convert_utf32_to_utf16be_with_errors(
        utf32_input.data(), utf32_input.size(), utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness, convert valid UTF-32 string into a UTF-16 string.
 *
 * This function assumes that the input string is valid UTF-32.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf32_to_utf16(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf32_to_utf16(std::span<const char32_t> valid_utf32_input,
                             std::span<char16_t> utf16_output) noexcept {

    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert_valid<endianness::NATIVE>(
        valid_utf32_input.data(), valid_utf32_input.size(),
        utf16_output.data());
  } else
    #endif
  {
    return convert_valid_utf32_to_utf16(valid_utf32_input.data(),
                                        valid_utf32_input.size(),
                                        utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-32 string into UTF-16LE string.
 *
 * This function assumes that the input string is valid UTF-32.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf32_to_utf16le(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf32_to_utf16le(std::span<const char32_t> valid_utf32_input,
                               std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert_valid<endianness::LITTLE>(
        valid_utf32_input.data(), valid_utf32_input.size(),
        utf16_output.data());
  } else
    #endif
  {
    return convert_valid_utf32_to_utf16le(valid_utf32_input.data(),
                                          valid_utf32_input.size(),
                                          utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert valid UTF-32 string into UTF-16BE string.
 *
 * This function assumes that the input string is valid UTF-32.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @param utf16_buffer   the pointer to a buffer that can hold the conversion
 * result
 * @return number of written code units; 0 if conversion is not possible
 */
simdutf_warn_unused size_t convert_valid_utf32_to_utf16be(
    const char32_t *input, size_t length, char16_t *utf16_buffer) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
convert_valid_utf32_to_utf16be(std::span<const char32_t> valid_utf32_input,
                               std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32_to_utf16::convert_valid<endianness::BIG>(
        valid_utf32_input.data(), valid_utf32_input.size(),
        utf16_output.data());
  } else
    #endif
  {
    return convert_valid_utf32_to_utf16be(valid_utf32_input.data(),
                                          valid_utf32_input.size(),
                                          utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16
/**
 * Change the endianness of the input. Can be used to go from UTF-16LE to
 * UTF-16BE or from UTF-16BE to UTF-16LE.
 *
 * This function does not validate the input.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to process
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @param output        the pointer to a buffer that can hold the conversion
 * result
 */
void change_endianness_utf16(const char16_t *input, size_t length,
                             char16_t *output) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_constexpr23 void
change_endianness_utf16(std::span<const char16_t> utf16_input,
                        std::span<char16_t> utf16_output) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::change_endianness_utf16(
        utf16_input.data(), utf16_input.size(), utf16_output.data());
  } else
    #endif
  {
    return change_endianness_utf16(utf16_input.data(), utf16_input.size(),
                                   utf16_output.data());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
/**
 * Compute the number of bytes that this UTF-32 string would require in UTF-8
 * format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-32 strings but in such cases the result is implementation defined.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @return the number of bytes required to encode the UTF-32 string as UTF-8
 */
simdutf_warn_unused size_t utf8_length_from_utf32(const char32_t *input,
                                                  size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf8_length_from_utf32(std::span<const char32_t> valid_utf32_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32::utf8_length_from_utf32(valid_utf32_input.data(),
                                                 valid_utf32_input.size());
  } else
    #endif
  {
    return utf8_length_from_utf32(valid_utf32_input.data(),
                                  valid_utf32_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
/**
 * Compute the number of two-byte code units that this UTF-32 string would
 * require in UTF-16 format.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-32 strings but in such cases the result is implementation defined.
 *
 * @param input         the UTF-32 string to convert
 * @param length        the length of the string in 4-byte code units (char32_t)
 * @return the number of bytes required to encode the UTF-32 string as UTF-16
 */
simdutf_warn_unused size_t utf16_length_from_utf32(const char32_t *input,
                                                   size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf16_length_from_utf32(std::span<const char32_t> valid_utf32_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf32::utf16_length_from_utf32(valid_utf32_input.data(),
                                                  valid_utf32_input.size());
  } else
    #endif
  {
    return utf16_length_from_utf32(valid_utf32_input.data(),
                                   valid_utf32_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Using native endianness; Compute the number of bytes that this UTF-16
 * string would require in UTF-32 format.
 *
 * This function is equivalent to count_utf16.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-16 strings but in such cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return the number of bytes required to encode the UTF-16LE string as UTF-32
 */
simdutf_warn_unused size_t utf32_length_from_utf16(const char16_t *input,
                                                   size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf32_length_from_utf16(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf32_length_from_utf16<endianness::NATIVE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf32_length_from_utf16(valid_utf16_input.data(),
                                   valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-16LE string would require in UTF-32
 * format.
 *
 * This function is equivalent to count_utf16le.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-16 strings but in such cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return the number of bytes required to encode the UTF-16LE string as UTF-32
 */
simdutf_warn_unused size_t utf32_length_from_utf16le(const char16_t *input,
                                                     size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf32_length_from_utf16le(
    std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf32_length_from_utf16<endianness::LITTLE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf32_length_from_utf16le(valid_utf16_input.data(),
                                     valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the number of bytes that this UTF-16BE string would require in UTF-32
 * format.
 *
 * This function is equivalent to count_utf16be.
 *
 * This function does not validate the input. It is acceptable to pass invalid
 * UTF-16 strings but in such cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to convert
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return the number of bytes required to encode the UTF-16BE string as UTF-32
 */
simdutf_warn_unused size_t utf32_length_from_utf16be(const char16_t *input,
                                                     size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
utf32_length_from_utf16be(
    std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::utf32_length_from_utf16<endianness::BIG>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return utf32_length_from_utf16be(valid_utf16_input.data(),
                                     valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16
/**
 * Count the number of code points (characters) in the string assuming that
 * it is valid.
 *
 * This function assumes that the input string is valid UTF-16 (native
 * endianness). It is acceptable to pass invalid UTF-16 strings but in such
 * cases the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16 string to process
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return number of code points
 */
simdutf_warn_unused size_t count_utf16(const char16_t *input,
                                       size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
count_utf16(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::count_code_points<endianness::NATIVE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return count_utf16(valid_utf16_input.data(), valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Count the number of code points (characters) in the string assuming that
 * it is valid.
 *
 * This function assumes that the input string is valid UTF-16LE.
 * It is acceptable to pass invalid UTF-16 strings but in such cases
 * the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16LE string to process
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return number of code points
 */
simdutf_warn_unused size_t count_utf16le(const char16_t *input,
                                         size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
count_utf16le(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::count_code_points<endianness::LITTLE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return count_utf16le(valid_utf16_input.data(), valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Count the number of code points (characters) in the string assuming that
 * it is valid.
 *
 * This function assumes that the input string is valid UTF-16BE.
 * It is acceptable to pass invalid UTF-16 strings but in such cases
 * the result is implementation defined.
 *
 * This function is not BOM-aware.
 *
 * @param input         the UTF-16BE string to process
 * @param length        the length of the string in 2-byte code units (char16_t)
 * @return number of code points
 */
simdutf_warn_unused size_t count_utf16be(const char16_t *input,
                                         size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
count_utf16be(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::count_code_points<endianness::BIG>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return count_utf16be(valid_utf16_input.data(), valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8
/**
 * Count the number of code points (characters) in the string assuming that
 * it is valid.
 *
 * This function assumes that the input string is valid UTF-8.
 * It is acceptable to pass invalid UTF-8 strings but in such cases
 * the result is implementation defined.
 *
 * @param input         the UTF-8 string to process
 * @param length        the length of the string in bytes
 * @return number of code points
 */
simdutf_warn_unused size_t count_utf8(const char *input,
                                      size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t count_utf8(
    const detail::input_span_of_byte_like auto &valid_utf8_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8::count_code_points(valid_utf8_input.data(),
                                           valid_utf8_input.size());
  } else
    #endif
  {
    return count_utf8(reinterpret_cast<const char *>(valid_utf8_input.data()),
                      valid_utf8_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Given a valid UTF-8 string having a possibly truncated last character,
 * this function checks the end of string. If the last character is truncated
 * (or partial), then it returns a shorter length (shorter by 1 to 3 bytes) so
 * that the short UTF-8 strings only contain complete characters. If there is no
 * truncated character, the original length is returned.
 *
 * This function assumes that the input string is valid UTF-8, but possibly
 * truncated.
 *
 * @param input         the UTF-8 string to process
 * @param length        the length of the string in bytes
 * @return the length of the string in bytes, possibly shorter by 1 to 3 bytes
 */
simdutf_warn_unused size_t trim_partial_utf8(const char *input, size_t length);
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
trim_partial_utf8(
    const detail::input_span_of_byte_like auto &valid_utf8_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf8::trim_partial_utf8(valid_utf8_input.data(),
                                           valid_utf8_input.size());
  } else
    #endif
  {
    return trim_partial_utf8(
        reinterpret_cast<const char *>(valid_utf8_input.data()),
        valid_utf8_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF8

#if SIMDUTF_FEATURE_UTF16
/**
 * Given a valid UTF-16BE string having a possibly truncated last character,
 * this function checks the end of string. If the last character is truncated
 * (or partial), then it returns a shorter length (shorter by 1 unit) so that
 * the short UTF-16BE strings only contain complete characters. If there is no
 * truncated character, the original length is returned.
 *
 * This function assumes that the input string is valid UTF-16BE, but possibly
 * truncated.
 *
 * @param input         the UTF-16BE string to process
 * @param length        the length of the string in bytes
 * @return the length of the string in bytes, possibly shorter by 1 unit
 */
simdutf_warn_unused size_t trim_partial_utf16be(const char16_t *input,
                                                size_t length);
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
trim_partial_utf16be(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::trim_partial_utf16<endianness::BIG>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return trim_partial_utf16be(valid_utf16_input.data(),
                                valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Given a valid UTF-16LE string having a possibly truncated last character,
 * this function checks the end of string. If the last character is truncated
 * (or partial), then it returns a shorter length (shorter by 1 unit) so that
 * the short UTF-16LE strings only contain complete characters. If there is no
 * truncated character, the original length is returned.
 *
 * This function assumes that the input string is valid UTF-16LE, but possibly
 * truncated.
 *
 * @param input         the UTF-16LE string to process
 * @param length        the length of the string in bytes
 * @return the length of the string in unit, possibly shorter by 1 unit
 */
simdutf_warn_unused size_t trim_partial_utf16le(const char16_t *input,
                                                size_t length);
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
trim_partial_utf16le(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::trim_partial_utf16<endianness::LITTLE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return trim_partial_utf16le(valid_utf16_input.data(),
                                valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Given a valid UTF-16 string having a possibly truncated last character,
 * this function checks the end of string. If the last character is truncated
 * (or partial), then it returns a shorter length (shorter by 1 unit) so that
 * the short UTF-16 strings only contain complete characters. If there is no
 * truncated character, the original length is returned.
 *
 * This function assumes that the input string is valid UTF-16, but possibly
 * truncated. We use the native endianness.
 *
 * @param input         the UTF-16 string to process
 * @param length        the length of the string in bytes
 * @return the length of the string in unit, possibly shorter by 1 unit
 */
simdutf_warn_unused size_t trim_partial_utf16(const char16_t *input,
                                              size_t length);
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
trim_partial_utf16(std::span<const char16_t> valid_utf16_input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::utf16::trim_partial_utf16<endianness::NATIVE>(
        valid_utf16_input.data(), valid_utf16_input.size());
  } else
    #endif
  {
    return trim_partial_utf16(valid_utf16_input.data(),
                              valid_utf16_input.size());
  }
}
  #endif // SIMDUTF_SPAN
#endif   // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_BASE64 || SIMDUTF_FEATURE_UTF16 ||                         \
    SIMDUTF_FEATURE_DETECT_ENCODING
  #ifndef SIMDUTF_NEED_TRAILING_ZEROES
    #define SIMDUTF_NEED_TRAILING_ZEROES 1
  #endif
#endif // SIMDUTF_FEATURE_BASE64 || SIMDUTF_FEATURE_UTF16 ||
       // SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_BASE64
// base64_options are used to specify the base64 encoding options.
// ASCII spaces are ' ', '\t', '\n', '\r', '\f'
// garbage characters are characters that are not part of the base64 alphabet
// nor ASCII spaces.
constexpr uint64_t base64_reverse_padding =
    2; /* modifier for base64_default and base64_url */
enum base64_options : uint64_t {
  base64_default = 0, /* standard base64 format (with padding) */
  base64_url = 1,     /* base64url format (no padding) */
  base64_default_no_padding =
      base64_default |
      base64_reverse_padding, /* standard base64 format without padding */
  base64_url_with_padding =
      base64_url | base64_reverse_padding, /* base64url with padding */
  base64_default_accept_garbage =
      4, /* standard base64 format accepting garbage characters, the input stops
            with the first '=' if any */
  base64_url_accept_garbage =
      5, /* base64url format accepting garbage characters, the input stops with
            the first '=' if any */
  base64_default_or_url =
      8, /* standard/base64url hybrid format (only meaningful for decoding!) */
  base64_default_or_url_accept_garbage =
      12, /* standard/base64url hybrid format accepting garbage characters
             (only meaningful for decoding!), the input stops with the first '='
             if any */
};

// last_chunk_handling_options are used to specify the handling of the last
// chunk in base64 decoding.
// https://tc39.es/proposal-arraybuffer-base64/spec/#sec-frombase64
enum last_chunk_handling_options : uint64_t {
  loose = 0,  /* standard base64 format, decode partial final chunk */
  strict = 1, /* error when the last chunk is partial, 2 or 3 chars, and
                 unpadded, or non-zero bit padding */
  stop_before_partial =
      2, /* if the last chunk is partial, ignore it (no error) */
  only_full_chunks =
      3 /* only decode full blocks (4 base64 characters, no padding) */
};

inline simdutf_constexpr23 bool
is_partial(last_chunk_handling_options options) {
  return (options == stop_before_partial) || (options == only_full_chunks);
}

namespace detail {
simdutf_warn_unused const char *find(const char *start, const char *end,
                                     char character) noexcept;
simdutf_warn_unused const char16_t *
find(const char16_t *start, const char16_t *end, char16_t character) noexcept;
} // namespace detail

/**
 * Find the first occurrence of a character in a string. If the character is
 * not found, return a pointer to the end of the string.
 * @param start        the start of the string
 * @param end          the end of the string
 * @param character    the character to find
 * @return a pointer to the first occurrence of the character in the string,
 * or a pointer to the end of the string if the character is not found.
 *
 */
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 const char *
find(const char *start, const char *end, char character) noexcept {
  #if SIMDUTF_CPLUSPLUS23
  if consteval {
    for (; start != end; ++start)
      if (*start == character)
        return start;
    return end;
  } else
  #endif
  {
    return detail::find(start, end, character);
  }
}
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 const char16_t *
find(const char16_t *start, const char16_t *end, char16_t character) noexcept {
    // implementation note: this is repeated instead of a template, to ensure
    // the api is still a function and compiles without concepts
  #if SIMDUTF_CPLUSPLUS23
  if consteval {
    for (; start != end; ++start)
      if (*start == character)
        return start;
    return end;
  } else
  #endif
  {
    return detail::find(start, end, character);
  }
}
}
  // We include base64_tables once.
  #include <simdutf/base64_tables.h>
  #include <simdutf/scalar/base64.h>

namespace simdutf {

  #if SIMDUTF_CPLUSPLUS17
inline std::string_view to_string(base64_options options) {
  switch (options) {
  case base64_default:
    return "base64_default";
  case base64_url:
    return "base64_url";
  case base64_reverse_padding:
    return "base64_reverse_padding";
  case base64_url_with_padding:
    return "base64_url_with_padding";
  case base64_default_accept_garbage:
    return "base64_default_accept_garbage";
  case base64_url_accept_garbage:
    return "base64_url_accept_garbage";
  case base64_default_or_url:
    return "base64_default_or_url";
  case base64_default_or_url_accept_garbage:
    return "base64_default_or_url_accept_garbage";
  }
  return "<unknown>";
}
  #endif // SIMDUTF_CPLUSPLUS17

  #if SIMDUTF_CPLUSPLUS17
inline std::string_view to_string(last_chunk_handling_options options) {
  switch (options) {
  case loose:
    return "loose";
  case strict:
    return "strict";
  case stop_before_partial:
    return "stop_before_partial";
  case only_full_chunks:
    return "only_full_chunks";
  }
  return "<unknown>";
}
  #endif

/**
 * Provide the maximal binary length in bytes given the base64 input.
 * As long as the input does not contain ignorable characters (e.g., ASCII
 * spaces or linefeed characters), the result is exact. In particular, the
 * function checks for padding characters.
 *
 * The function is fast (constant time). It checks up to two characters at
 * the end of the string. The input is not otherwise validated or read.
 *
 * @param input         the base64 input to process
 * @param length        the length of the base64 input in bytes
 * @return maximum number of binary bytes
 */
simdutf_warn_unused size_t
maximal_binary_length_from_base64(const char *input, size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
maximal_binary_length_from_base64(
    const detail::input_span_of_byte_like auto &input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::maximal_binary_length_from_base64(
        detail::constexpr_cast_ptr<uint8_t>(input.data()), input.size());
  } else
    #endif
  {
    return maximal_binary_length_from_base64(
        reinterpret_cast<const char *>(input.data()), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Provide the maximal binary length in bytes given the base64 input.
 * As long as the input does not contain ignorable characters (e.g., ASCII
 * spaces or linefeed characters), the result is exact. In particular, the
 * function checks for padding characters.
 *
 * The function is fast (constant time). It checks up to two characters at
 * the end of the string. The input is not otherwise validated or read.
 *
 * @param input         the base64 input to process, in ASCII stored as 16-bit
 * units
 * @param length        the length of the base64 input in 16-bit units
 * @return maximal number of binary bytes
 */
simdutf_warn_unused size_t maximal_binary_length_from_base64(
    const char16_t *input, size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
maximal_binary_length_from_base64(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::maximal_binary_length_from_base64(input.data(),
                                                             input.size());
  } else
    #endif
  {
    return maximal_binary_length_from_base64(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the binary length from a base64 input.
 * This function is useful for base64 inputs that may contain ASCII whitespaces
 * (such as line breaks). For such inputs, the result is exact, and for any
 * inputs the result can be used to size the output buffer passed to
 * `base64_to_binary`.
 *
 * The function ignores whitespace and does not require padding characters
 * ('=').
 *
 * @param input         the base64 input to process
 * @param length        the length of the base64 input in bytes
 * @return number of binary bytes
 */
simdutf_warn_unused size_t binary_length_from_base64(const char *input,
                                                     size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
binary_length_from_base64(
    const detail::input_span_of_byte_like auto &input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::binary_length_from_base64(input.data(),
                                                     input.size());
  } else
    #endif
  {
    return binary_length_from_base64(
        reinterpret_cast<const char *>(input.data()), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Compute the binary length from a base64 input.
 * This function is useful for base64 inputs that may contain ASCII whitespaces
 * (such as line breaks). For such inputs, the result is exact, and for any
 * inputs the result can be used to size the output buffer passed to
 * `base64_to_binary`.
 *
 * The function ignores whitespace and does not require padding characters
 * ('=').
 *
 * @param input         the base64 input to process, in ASCII stored as 16-bit
 * units
 * @param length        the length of the base64 input in 16-bit units
 * @return number of binary bytes
 */
simdutf_warn_unused size_t binary_length_from_base64(const char16_t *input,
                                                     size_t length) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
binary_length_from_base64(std::span<const char16_t> input) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::binary_length_from_base64(input.data(),
                                                     input.size());
  } else
    #endif
  {
    return binary_length_from_base64(input.data(), input.size());
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert a base64 input to a binary output.
 *
 * This function follows the WHATWG forgiving-base64 format, which means that it
 * will ignore any ASCII spaces in the input. You may provide a padded input
 * (with one or two equal signs at the end) or an unpadded input (without any
 * equal signs at the end).
 *
 * See https://infra.spec.whatwg.org/#forgiving-base64-decode
 *
 * This function will fail in case of invalid input. When last_chunk_options =
 * loose, there are two possible reasons for failure: the input contains a
 * number of base64 characters that when divided by 4, leaves a single remainder
 * character (BASE64_INPUT_REMAINDER), or the input contains a character that is
 * not a valid base64 character (INVALID_BASE64_CHARACTER).
 *
 * When the error is INVALID_BASE64_CHARACTER, r.count contains the index in the
 * input where the invalid character was found. When the error is
 * BASE64_INPUT_REMAINDER, then r.count contains the number of bytes decoded.
 *
 * The default option (simdutf::base64_default) expects the characters `+` and
 * `/` as part of its alphabet. The URL option (simdutf::base64_url) expects the
 * characters `-` and `_` as part of its alphabet.
 *
 * The padding (`=`) is validated if present. There may be at most two padding
 * characters at the end of the input. If there are any padding characters, the
 * total number of characters (excluding spaces but including padding
 * characters) must be divisible by four.
 *
 * You should call this function with a buffer that is at least
 * maximal_binary_length_from_base64(input, length) bytes long. If you fail to
 * provide that much space, the function may cause a buffer overflow.
 *
 * Advanced users may want to tailor how the last chunk is handled. By default,
 * we use a loose (forgiving) approach but we also support a strict approach
 * as well as a stop_before_partial approach, as per the following proposal:
 *
 * https://tc39.es/proposal-arraybuffer-base64/spec/#sec-frombase64
 *
 * @param input         the base64 string to process
 * @param length        the length of the string in bytes
 * @param output        the pointer to a buffer that can hold the conversion
 * result (should be at least maximal_binary_length_from_base64(input, length)
 * bytes long).
 * @param options       the base64 options to use, usually base64_default or
 * base64_url, and base64_default by default.
 * @param last_chunk_options the last chunk handling options,
 * last_chunk_handling_options::loose by default
 * but can also be last_chunk_handling_options::strict or
 * last_chunk_handling_options::stop_before_partial.
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and either position of the error
 * (in the input in bytes) if any, or the number of bytes written if successful.
 */
simdutf_warn_unused result base64_to_binary(
    const char *input, size_t length, char *output,
    base64_options options = base64_default,
    last_chunk_handling_options last_chunk_options = loose) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
base64_to_binary(
    const detail::input_span_of_byte_like auto &input,
    detail::output_span_of_byte_like auto &&binary_output,
    base64_options options = base64_default,
    last_chunk_handling_options last_chunk_options = loose) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::base64_to_binary_details_impl(
        input.data(), input.size(), binary_output.data(), options,
        last_chunk_options);
  } else
    #endif
  {
    return base64_to_binary(reinterpret_cast<const char *>(input.data()),
                            input.size(),
                            reinterpret_cast<char *>(binary_output.data()),
                            options, last_chunk_options);
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Provide the base64 length in bytes given the length of a binary input.
 *
 * @param length        the length of the input in bytes
 * @return number of base64 bytes
 */
inline simdutf_warn_unused simdutf_constexpr23 size_t base64_length_from_binary(
    size_t length, base64_options options = base64_default) noexcept {
  return scalar::base64::base64_length_from_binary(length, options);
}

/**
 * Provide the base64 length in bytes given the length of a binary input,
 * taking into account line breaks.
 *
 * @param length        the length of the input in bytes
 * @param line_length   the length of lines, must be at least 4 (otherwise it is
 * interpreted as 4),
 * @return number of base64 bytes
 */
inline simdutf_warn_unused simdutf_constexpr23 size_t
base64_length_from_binary_with_lines(
    size_t length, base64_options options = base64_default,
    size_t line_length = default_line_length) noexcept {
  return scalar::base64::base64_length_from_binary_with_lines(length, options,
                                                              line_length);
}

/**
 * Convert a binary input to a base64 output.
 *
 * The default option (simdutf::base64_default) uses the characters `+` and `/`
 * as part of its alphabet. Further, it adds padding (`=`) at the end of the
 * output to ensure that the output length is a multiple of four.
 *
 * The URL option (simdutf::base64_url) uses the characters `-` and `_` as part
 * of its alphabet. No padding is added at the end of the output.
 *
 * This function always succeeds.
 *
 * @param input         the binary to process
 * @param length        the length of the input in bytes
 * @param output        the pointer to a buffer that can hold the conversion
 * result (should be at least base64_length_from_binary(length) bytes long)
 * @param options       the base64 options to use, can be base64_default or
 * base64_url, is base64_default by default.
 * @return number of written bytes, will be equal to
 * base64_length_from_binary(length, options)
 */
size_t binary_to_base64(const char *input, size_t length, char *output,
                        base64_options options = base64_default) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
binary_to_base64(const detail::input_span_of_byte_like auto &input,
                 detail::output_span_of_byte_like auto &&binary_output,
                 base64_options options = base64_default) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::tail_encode_base64(
        binary_output.data(), input.data(), input.size(), options);
  } else
    #endif
  {
    return binary_to_base64(
        reinterpret_cast<const char *>(input.data()), input.size(),
        reinterpret_cast<char *>(binary_output.data()), options);
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Convert a binary input to a base64 output with line breaks.
 *
 * The default option (simdutf::base64_default) uses the characters `+` and `/`
 * as part of its alphabet. Further, it adds padding (`=`) at the end of the
 * output to ensure that the output length is a multiple of four.
 *
 * The URL option (simdutf::base64_url) uses the characters `-` and `_` as part
 * of its alphabet. No padding is added at the end of the output.
 *
 * This function always succeeds.
 *
 * @param input         the binary to process
 * @param length        the length of the input in bytes
 * @param output        the pointer to a buffer that can hold the conversion
 * result (should be at least base64_length_from_binary_with_lines(length,
 * options, line_length) bytes long)
 * @param line_length   the length of lines, must be at least 4 (otherwise it is
 * interpreted as 4),
 * @param options       the base64 options to use, can be base64_default or
 * base64_url, is base64_default by default.
 * @return number of written bytes, will be equal to
 * base64_length_from_binary_with_lines(length, options)
 */
size_t
binary_to_base64_with_lines(const char *input, size_t length, char *output,
                            size_t line_length = simdutf::default_line_length,
                            base64_options options = base64_default) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 size_t
binary_to_base64_with_lines(
    const detail::input_span_of_byte_like auto &input,
    detail::output_span_of_byte_like auto &&binary_output,
    size_t line_length = simdutf::default_line_length,
    base64_options options = base64_default) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::tail_encode_base64_impl<true>(
        binary_output.data(), input.data(), input.size(), options, line_length);
  } else
    #endif
  {
    return binary_to_base64_with_lines(
        reinterpret_cast<const char *>(input.data()), input.size(),
        reinterpret_cast<char *>(binary_output.data()), line_length, options);
  }
}
  #endif // SIMDUTF_SPAN

  #if SIMDUTF_ATOMIC_REF
/**
 * Convert a binary input to a base64 output, using atomic accesses.
 * This function comes with a potentially significant performance
 * penalty, but it may be useful in some cases where the input
 * buffers are shared between threads, to avoid undefined
 * behavior in case of data races.
 *
 * The function is for advanced users. Its main use case is when
 * to silence sanitizer warnings. We have no documented use case
 * where this function is actually necessary in terms of practical correctness.
 *
 * This function is only available when simdutf is compiled with
 * C++20 support and __cpp_lib_atomic_ref >= 201806L. You may check
 * the availability of this function by checking the macro
 * SIMDUTF_ATOMIC_REF.
 *
 * The default option (simdutf::base64_default) uses the characters `+` and `/`
 * as part of its alphabet. Further, it adds padding (`=`) at the end of the
 * output to ensure that the output length is a multiple of four.
 *
 * The URL option (simdutf::base64_url) uses the characters `-` and `_` as part
 * of its alphabet. No padding is added at the end of the output.
 *
 * This function always succeeds.
 *
 * This function is considered experimental. It is not tested by default
 * (see the CMake option SIMDUTF_ATOMIC_BASE64_TESTS) nor is it fuzz tested.
 * It is not documented in the public API documentation (README). It is
 * offered on a best effort basis. We rely on the community for further
 * testing and feedback.
 *
 * @brief atomic_binary_to_base64
 * @param input         the binary to process
 * @param length        the length of the input in bytes
 * @param output        the pointer to a buffer that can hold the conversion
 * result (should be at least base64_length_from_binary(length) bytes long)
 * @param options       the base64 options to use, can be base64_default or
 * base64_url, is base64_default by default.
 * @return number of written bytes, will be equal to
 * base64_length_from_binary(length, options)
 */
size_t
atomic_binary_to_base64(const char *input, size_t length, char *output,
                        base64_options options = base64_default) noexcept;
    #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused size_t
atomic_binary_to_base64(const detail::input_span_of_byte_like auto &input,
                        detail::output_span_of_byte_like auto &&binary_output,
                        base64_options options = base64_default) noexcept {
  return atomic_binary_to_base64(
      reinterpret_cast<const char *>(input.data()), input.size(),
      reinterpret_cast<char *>(binary_output.data()), options);
}
    #endif // SIMDUTF_SPAN
  #endif   // SIMDUTF_ATOMIC_REF

/**
 * Convert a base64 input to a binary output.
 *
 * This function follows the WHATWG forgiving-base64 format, which means that it
 * will ignore any ASCII spaces in the input. You may provide a padded input
 * (with one or two equal signs at the end) or an unpadded input (without any
 * equal signs at the end).
 *
 * See https://infra.spec.whatwg.org/#forgiving-base64-decode
 *
 * This function will fail in case of invalid input. When last_chunk_options =
 * loose, there are two possible reasons for failure: the input contains a
 * number of base64 characters that when divided by 4, leaves a single remainder
 * character (BASE64_INPUT_REMAINDER), or the input contains a character that is
 * not a valid base64 character (INVALID_BASE64_CHARACTER).
 *
 * When the error is INVALID_BASE64_CHARACTER, r.count contains the index in the
 * input where the invalid character was found. When the error is
 * BASE64_INPUT_REMAINDER, then r.count contains the number of bytes decoded.
 *
 * The default option (simdutf::base64_default) expects the characters `+` and
 * `/` as part of its alphabet. The URL option (simdutf::base64_url) expects the
 * characters `-` and `_` as part of its alphabet.
 *
 * The padding (`=`) is validated if present. There may be at most two padding
 * characters at the end of the input. If there are any padding characters, the
 * total number of characters (excluding spaces but including padding
 * characters) must be divisible by four.
 *
 * You should call this function with a buffer that is at least
 * maximal_binary_length_from_base64(input, length) bytes long. If you fail
 * to provide that much space, the function may cause a buffer overflow.
 *
 * Advanced users may want to tailor how the last chunk is handled. By default,
 * we use a loose (forgiving) approach but we also support a strict approach
 * as well as a stop_before_partial approach, as per the following proposal:
 *
 * https://tc39.es/proposal-arraybuffer-base64/spec/#sec-frombase64
 *
 * @param input         the base64 string to process, in ASCII stored as 16-bit
 * units
 * @param length        the length of the string in 16-bit units
 * @param output        the pointer to a buffer that can hold the conversion
 * result (should be at least maximal_binary_length_from_base64(input, length)
 * bytes long).
 * @param options       the base64 options to use, can be base64_default or
 * base64_url, is base64_default by default.
 * @param last_chunk_options the last chunk handling options,
 * last_chunk_handling_options::loose by default
 * but can also be last_chunk_handling_options::strict or
 * last_chunk_handling_options::stop_before_partial.
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and position of the
 * INVALID_BASE64_CHARACTER error (in the input in units) if any, or the number
 * of bytes written if successful.
 */
simdutf_warn_unused result
base64_to_binary(const char16_t *input, size_t length, char *output,
                 base64_options options = base64_default,
                 last_chunk_handling_options last_chunk_options =
                     last_chunk_handling_options::loose) noexcept;
  #if SIMDUTF_SPAN
simdutf_really_inline simdutf_warn_unused simdutf_constexpr23 result
base64_to_binary(
    std::span<const char16_t> input,
    detail::output_span_of_byte_like auto &&binary_output,
    base64_options options = base64_default,
    last_chunk_handling_options last_chunk_options = loose) noexcept {
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    return scalar::base64::base64_to_binary_details_impl(
        input.data(), input.size(), binary_output.data(), options,
        last_chunk_options);
  } else
    #endif
  {
    return base64_to_binary(input.data(), input.size(),
                            reinterpret_cast<char *>(binary_output.data()),
                            options, last_chunk_options);
  }
}
  #endif // SIMDUTF_SPAN

/**
 * Check if a character is an ignorable base64 character.
 * Checking a large input, character by character, is not computationally
 * efficient.
 *
 * @param input         the character to check
 * @param options       the base64 options to use, is base64_default by default.
 * @return true if the character is an ignorable base64 character, false
 * otherwise.
 */
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 bool
base64_ignorable(char input, base64_options options = base64_default) noexcept {
  return scalar::base64::is_ignorable(input, options);
}
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 bool
base64_ignorable(char16_t input,
                 base64_options options = base64_default) noexcept {
  return scalar::base64::is_ignorable(input, options);
}

/**
 * Check if a character is a valid base64 character.
 * Checking a large input, character by character, is not computationally
 * efficient.
 * Note that padding characters are not considered valid base64 characters in
 * this context, nor are spaces.
 *
 * @param input         the character to check
 * @param options       the base64 options to use, is base64_default by default.
 * @return true if the character is a base64 character, false otherwise.
 */
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 bool
base64_valid(char input, base64_options options = base64_default) noexcept {
  return scalar::base64::is_base64(input, options);
}
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 bool
base64_valid(char16_t input, base64_options options = base64_default) noexcept {
  return scalar::base64::is_base64(input, options);
}

/**
 * Check if a character is a valid base64 character or the padding character
 * ('='). Checking a large input, character by character, is not computationally
 * efficient.
 *
 * @param input         the character to check
 * @param options       the base64 options to use, is base64_default by default.
 * @return true if the character is a base64 character, false otherwise.
 */
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 bool
base64_valid_or_padding(char input,
                        base64_options options = base64_default) noexcept {
  return scalar::base64::is_base64_or_padding(input, options);
}
simdutf_warn_unused simdutf_really_inline simdutf_constexpr23 bool
base64_valid_or_padding(char16_t input,
                        base64_options options = base64_default) noexcept {
  return scalar::base64::is_base64_or_padding(input, options);
}

/**
 * Convert a base64 input to a binary output.
 *
 * This function follows the WHATWG forgiving-base64 format, which means that it
 * will ignore any ASCII spaces in the input. You may provide a padded input
 * (with one or two equal signs at the end) or an unpadded input (without any
 * equal signs at the end).
 *
 * See https://infra.spec.whatwg.org/#forgiving-base64-decode
 *
 * This function will fail in case of invalid input. When last_chunk_options =
 * loose, there are three possible reasons for failure: the input contains a
 * number of base64 characters that when divided by 4, leaves a single remainder
 * character (BASE64_INPUT_REMAINDER), the input contains a character that is
 * not a valid base64 character (INVALID_BASE64_CHARACTER), or the output buffer
 * is too small (OUTPUT_BUFFER_TOO_SMALL).
 *
 * When OUTPUT_BUFFER_TOO_SMALL, we return both the number of bytes written
 * and the number of units processed, see description of the parameters and
 * returned value.
 *
 * When the error is INVALID_BASE64_CHARACTER, r.count contains the index in the
 * input where the invalid character was found. When the error is
 * BASE64_INPUT_REMAINDER, then r.count contains the number of bytes decoded.
 *
 * The default option (simdutf::base64_default) expects the characters `+` and
 * `/` as part of its alphabet. The URL option (simdutf::base64_url) expects the
 * characters `-` and `_` as part of its alphabet.
 *
 * The padding (`=`) is validated if present. There may be at most two padding
 * characters at the end of the input. If there are any padding characters, the
 * total number of characters (excluding spaces but including padding
 * characters) must be divisible by four.
 *
 * The INVALID_BASE64_CHARACTER cases are considered fatal and you are expected
 * to discard the output unless the parameter decode_up_to_bad_char is set to
 * true. In that case, the function will decode up to the first invalid
 * character. Extra padding characters ('=') are considered invalid characters.
 *
 * Advanced users may want to tailor how the last chunk is handled. By default,
 * we use a loose (forgiving) approach but we also support a strict approach
 * as well as a stop_before_partial approach, as per the following proposal:
 *
 * https://tc39.es/proposal-arraybuffer-base64/spec/#sec-frombase64
 *
 * @param input         the base64 string to process, in ASCII stored as 8-bit
 * or 16-bit units
 * @param length        the length of the string in 8-bit or 16-bit units.
 * @param output        the pointer to a buffer that can hold the conversion
 * result.
 * @param outlen        the number of bytes that can be written in the output
 * buffer. Upon return, it is modified to reflect how many bytes were written.
 * @param options       the base64 options to use, can be base64_default or
 * base64_url, is base64_default by default.
 * @param last_chunk_options the last chunk handling options,
 * last_chunk_handling_options::loose by default
 * but can also be last_chunk_handling_options::strict or
 * last_chunk_handling_options::stop_before_partial.
 * @param decode_up_to_bad_char if true, the function will decode up to the
 * first invalid character. By default (false), it is assumed that the output
 * buffer is to be discarded. When there are multiple errors in the input,
 * using decode_up_to_bad_char might trigger a different error.
 * @return a result pair struct (of type simdutf::result containing the two
 * fields error and count) with an error code and position of the
 * INVALID_BASE64_CHARACTER error (in the input in units) if any, or the number
 * of units processed if successful.
 */
simdutf_warn_unused result
base64_to_binary_safe(const char *input, size_t length, char *output,
                      size_t &outlen, base64_options options = base64_default,
                      last_chunk_handling_options last_chunk_options =
                          last_chunk_handling_options::loose,
                      bool decode_up_to_bad_char = false) noexcept;
// the span overload has moved to the bottom of the file

simdutf_warn_unused result
base64_to_binary_safe(const char16_t *input, size_t length, char *output,
                      size_t &outlen, base64_options options = base64_default,
                      last_chunk_handling_options last_chunk_options =
                          last_chunk_handling_options::loose,
                      bool decode_up_to_bad_char = false) noexcept;
  // span overload moved to bottom of file

  #if SIMDUTF_ATOMIC_REF
/**
 * Convert a base64 input to a binary output with a size limit and using atomic
 * operations.
 *
 * Like `base64_to_binary_safe` but using atomic operations, this function is
 * thread-safe for concurrent memory access, allowing the output
 * buffers to be shared between threads without undefined behavior in case of
 * data races.
 *
 * This function comes with a potentially significant performance penalty, but
 * is useful when thread safety is needed during base64 decoding.
 *
 * This function is only available when simdutf is compiled with
 * C++20 support and __cpp_lib_atomic_ref >= 201806L. You may check
 * the availability of this function by checking the macro
 * SIMDUTF_ATOMIC_REF.
 *
 * This function is considered experimental. It is not tested by default
 * (see the CMake option SIMDUTF_ATOMIC_BASE64_TESTS) nor is it fuzz tested.
 * It is not documented in the public API documentation (README). It is
 * offered on a best effort basis. We rely on the community for further
 * testing and feedback.
 *
 * @param input         the base64 input to decode
 * @param length        the length of the input in bytes
 * @param output        the pointer to buffer that can hold the conversion
 * result
 * @param outlen        the number of bytes that can be written in the output
 * buffer. Upon return, it is modified to reflect how many bytes were written.
 * @param options       the base64 options to use (default, url, etc.)
 * @param last_chunk_options the last chunk handling options (loose, strict,
 * stop_before_partial)
 * @param decode_up_to_bad_char if true, the function will decode up to the
 * first invalid character. By default (false), it is assumed that the output
 * buffer is to be discarded. When there are multiple errors in the input,
 * using decode_up_to_bad_char might trigger a different error.
 * @return a result struct with an error code and count indicating error
 * position or success
 */
simdutf_warn_unused result atomic_base64_to_binary_safe(
    const char *input, size_t length, char *output, size_t &outlen,
    base64_options options = base64_default,
    last_chunk_handling_options last_chunk_options =
        last_chunk_handling_options::loose,
    bool decode_up_to_bad_char = false) noexcept;
simdutf_warn_unused result atomic_base64_to_binary_safe(
    const char16_t *input, size_t length, char *output, size_t &outlen,
    base64_options options = base64_default,
    last_chunk_handling_options last_chunk_options = loose,
    bool decode_up_to_bad_char = false) noexcept;
    #if SIMDUTF_SPAN
/**
 * @brief span overload
 * @return a tuple of result and outlen
 */
simdutf_really_inline simdutf_warn_unused std::tuple<result, std::size_t>
atomic_base64_to_binary_safe(
    const detail::input_span_of_byte_like auto &binary_input,
    detail::output_span_of_byte_like auto &&output,
    base64_options options = base64_default,
    last_chunk_handling_options last_chunk_options =
        last_chunk_handling_options::loose,
    bool decode_up_to_bad_char = false) noexcept {
  size_t outlen = output.size();
  auto ret = atomic_base64_to_binary_safe(
      reinterpret_cast<const char *>(binary_input.data()), binary_input.size(),
      reinterpret_cast<char *>(output.data()), outlen, options,
      last_chunk_options, decode_up_to_bad_char);
  return {ret, outlen};
}
/**
 * @brief span overload
 * @return a tuple of result and outlen
 */
simdutf_warn_unused std::tuple<result, std::size_t>
atomic_base64_to_binary_safe(
    std::span<const char16_t> base64_input,
    detail::output_span_of_byte_like auto &&binary_output,
    base64_options options = base64_default,
    last_chunk_handling_options last_chunk_options = loose,
    bool decode_up_to_bad_char = false) noexcept {
  size_t outlen = binary_output.size();
  auto ret = atomic_base64_to_binary_safe(
      base64_input.data(), base64_input.size(),
      reinterpret_cast<char *>(binary_output.data()), outlen, options,
      last_chunk_options, decode_up_to_bad_char);
  return {ret, outlen};
}
    #endif // SIMDUTF_SPAN
  #endif   // SIMDUTF_ATOMIC_REF

#endif // SIMDUTF_FEATURE_BASE64

/**
 * An implementation of simdutf for a particular CPU architecture.
 *
 * Also used to maintain the currently active implementation. The active
 * implementation is automatically initialized on first use to the most advanced
 * implementation supported by the host.
 */
class implementation {
public:
  /**
   * The name of this implementation.
   *
   *     const implementation *impl = simdutf::active_implementation;
   *     cout << "simdutf is optimized for " << impl->name() << "(" <<
   * impl->description() << ")" << endl;
   *
   * @return the name of the implementation, e.g. "haswell", "westmere", "arm64"
   */
  virtual std::string name() const { return std::string(_name); }

  /**
   * The description of this implementation.
   *
   *     const implementation *impl = simdutf::active_implementation;
   *     cout << "simdutf is optimized for " << impl->name() << "(" <<
   * impl->description() << ")" << endl;
   *
   * @return the name of the implementation, e.g. "haswell", "westmere", "arm64"
   */
  virtual std::string description() const { return std::string(_description); }

  /**
   * The instruction sets this implementation is compiled against
   * and the current CPU match. This function may poll the current CPU/system
   * and should therefore not be called too often if performance is a concern.
   *
   *
   * @return true if the implementation can be safely used on the current system
   * (determined at runtime)
   */
  bool supported_by_runtime_system() const;

#if SIMDUTF_FEATURE_DETECT_ENCODING
  /**
   * This function will try to detect the encoding
   * @param input the string to identify
   * @param length the length of the string in bytes.
   * @return the encoding type detected
   */
  virtual encoding_type autodetect_encoding(const char *input,
                                            size_t length) const noexcept;

  /**
   * This function will try to detect the possible encodings in one pass
   * @param input the string to identify
   * @param length the length of the string in bytes.
   * @return the encoding type detected
   */
  virtual int detect_encodings(const char *input,
                               size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_DETECT_ENCODING

  /**
   * @private For internal implementation use
   *
   * The instruction sets this implementation is compiled against.
   *
   * @return a mask of all required `internal::instruction_set::` values
   */
  virtual uint32_t required_instruction_sets() const {
    return _required_instruction_sets;
  }

#if SIMDUTF_FEATURE_UTF8 || SIMDUTF_FEATURE_DETECT_ENCODING
  /**
   * Validate the UTF-8 string.
   *
   * Overridden by each implementation.
   *
   * @param buf the UTF-8 string to validate.
   * @param len the length of the string in bytes.
   * @return true if and only if the string is valid UTF-8.
   */
  simdutf_warn_unused virtual bool validate_utf8(const char *buf,
                                                 size_t len) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 || SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_UTF8
  /**
   * Validate the UTF-8 string and stop on errors.
   *
   * Overridden by each implementation.
   *
   * @param buf the UTF-8 string to validate.
   * @param len the length of the string in bytes.
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result
  validate_utf8_with_errors(const char *buf, size_t len) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8

#if SIMDUTF_FEATURE_ASCII
  /**
   * Validate the ASCII string.
   *
   * Overridden by each implementation.
   *
   * @param buf the ASCII string to validate.
   * @param len the length of the string in bytes.
   * @return true if and only if the string is valid ASCII.
   */
  simdutf_warn_unused virtual bool
  validate_ascii(const char *buf, size_t len) const noexcept = 0;

  /**
   * Validate the ASCII string and stop on error.
   *
   * Overridden by each implementation.
   *
   * @param buf the ASCII string to validate.
   * @param len the length of the string in bytes.
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result
  validate_ascii_with_errors(const char *buf, size_t len) const noexcept = 0;

#endif // SIMDUTF_FEATURE_ASCII

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_ASCII
  /**
   * Validate the ASCII string as a UTF-16BE sequence.
   * An UTF-16 sequence is considered an ASCII sequence
   * if it could be converted to an ASCII string losslessly.
   *
   * Overridden by each implementation.
   *
   * @param buf the UTF-16BE string to validate.
   * @param len the length of the string in bytes.
   * @return true if and only if the string is valid ASCII.
   */
  simdutf_warn_unused virtual bool
  validate_utf16be_as_ascii(const char16_t *buf, size_t len) const noexcept = 0;

  /**
   * Validate the ASCII string as a UTF-16LE sequence.
   * An UTF-16 sequence is considered an ASCII sequence
   * if it could be converted to an ASCII string losslessly.
   *
   * Overridden by each implementation.
   *
   * @param buf the UTF-16LE string to validate.
   * @param len the length of the string in bytes.
   * @return true if and only if the string is valid ASCII.
   */
  simdutf_warn_unused virtual bool
  validate_utf16le_as_ascii(const char16_t *buf, size_t len) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_ASCII

#if SIMDUTF_FEATURE_UTF16 || SIMDUTF_FEATURE_DETECT_ENCODING
  /**
   * Validate the UTF-16LE string.This function may be best when you expect
   * the input to be almost always valid. Otherwise, consider using
   * validate_utf16le_with_errors.
   *
   * Overridden by each implementation.
   *
   * This function is not BOM-aware.
   *
   * @param buf the UTF-16LE string to validate.
   * @param len the length of the string in number of 2-byte code units
   * (char16_t).
   * @return true if and only if the string is valid UTF-16LE.
   */
  simdutf_warn_unused virtual bool
  validate_utf16le(const char16_t *buf, size_t len) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 || SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_UTF16
  /**
   * Validate the UTF-16BE string. This function may be best when you expect
   * the input to be almost always valid. Otherwise, consider using
   * validate_utf16be_with_errors.
   *
   * Overridden by each implementation.
   *
   * This function is not BOM-aware.
   *
   * @param buf the UTF-16BE string to validate.
   * @param len the length of the string in number of 2-byte code units
   * (char16_t).
   * @return true if and only if the string is valid UTF-16BE.
   */
  simdutf_warn_unused virtual bool
  validate_utf16be(const char16_t *buf, size_t len) const noexcept = 0;

  /**
   * Validate the UTF-16LE string and stop on error.  It might be faster than
   * validate_utf16le when an error is expected to occur early.
   *
   * Overridden by each implementation.
   *
   * This function is not BOM-aware.
   *
   * @param buf the UTF-16LE string to validate.
   * @param len the length of the string in number of 2-byte code units
   * (char16_t).
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result
  validate_utf16le_with_errors(const char16_t *buf,
                               size_t len) const noexcept = 0;

  /**
   * Validate the UTF-16BE string and stop on error. It might be faster than
   * validate_utf16be when an error is expected to occur early.
   *
   * Overridden by each implementation.
   *
   * This function is not BOM-aware.
   *
   * @param buf the UTF-16BE string to validate.
   * @param len the length of the string in number of 2-byte code units
   * (char16_t).
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result
  validate_utf16be_with_errors(const char16_t *buf,
                               size_t len) const noexcept = 0;
  /**
   * Copies the UTF-16LE string while replacing mismatched surrogates with the
   * Unicode replacement character U+FFFD. We allow the input and output to be
   * the same buffer so that the correction is done in-place.
   *
   * Overridden by each implementation.
   *
   * @param input the UTF-16LE string to correct.
   * @param len the length of the string in number of 2-byte code units
   * (char16_t).
   * @param output the output buffer.
   */
  virtual void to_well_formed_utf16le(const char16_t *input, size_t len,
                                      char16_t *output) const noexcept = 0;
  /**
   * Copies the UTF-16BE string while replacing mismatched surrogates with the
   * Unicode replacement character U+FFFD. We allow the input and output to be
   * the same buffer so that the correction is done in-place.
   *
   * Overridden by each implementation.
   *
   * @param input the UTF-16BE string to correct.
   * @param len the length of the string in number of 2-byte code units
   * (char16_t).
   * @param output the output buffer.
   */
  virtual void to_well_formed_utf16be(const char16_t *input, size_t len,
                                      char16_t *output) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF32 || SIMDUTF_FEATURE_DETECT_ENCODING
  /**
   * Validate the UTF-32 string.
   *
   * Overridden by each implementation.
   *
   * This function is not BOM-aware.
   *
   * @param buf the UTF-32 string to validate.
   * @param len the length of the string in number of 4-byte code units
   * (char32_t).
   * @return true if and only if the string is valid UTF-32.
   */
  simdutf_warn_unused virtual bool
  validate_utf32(const char32_t *buf, size_t len) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF32 || SIMDUTF_FEATURE_DETECT_ENCODING

#if SIMDUTF_FEATURE_UTF32
  /**
   * Validate the UTF-32 string and stop on error.
   *
   * Overridden by each implementation.
   *
   * This function is not BOM-aware.
   *
   * @param buf the UTF-32 string to validate.
   * @param len the length of the string in number of 4-byte code units
   * (char32_t).
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result
  validate_utf32_with_errors(const char32_t *buf,
                             size_t len) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
  /**
   * Convert Latin1 string into UTF-8 string.
   *
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the Latin1 string to convert
   * @param length        the length of the string in bytes
   * @param utf8_output  the pointer to buffer that can hold conversion result
   * @return the number of written char; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_latin1_to_utf8(const char *input, size_t length,
                         char *utf8_output) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
  /**
   * Convert possibly Latin1 string into UTF-16LE string.
   *
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the Latin1  string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char16_t; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_latin1_to_utf16le(const char *input, size_t length,
                            char16_t *utf16_output) const noexcept = 0;

  /**
   * Convert Latin1 string into UTF-16BE string.
   *
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the Latin1 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char16_t; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_latin1_to_utf16be(const char *input, size_t length,
                            char16_t *utf16_output) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1
  /**
   * Convert Latin1 string into UTF-32 string.
   *
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the Latin1 string to convert
   * @param length        the length of the string in bytes
   * @param utf32_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char32_t; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_latin1_to_utf32(const char *input, size_t length,
                          char32_t *utf32_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
  /**
   * Convert possibly broken UTF-8 string into latin1 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param latin1_output  the pointer to buffer that can hold conversion result
   * @return the number of written char; 0 if the input was not valid UTF-8
   * string or if it cannot be represented as Latin1
   */
  simdutf_warn_unused virtual size_t
  convert_utf8_to_latin1(const char *input, size_t length,
                         char *latin1_output) const noexcept = 0;

  /**
   * Convert possibly broken UTF-8 string into latin1 string with errors.
   * If the string cannot be represented as Latin1, an error
   * code is returned.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param latin1_output  the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result
  convert_utf8_to_latin1_with_errors(const char *input, size_t length,
                                     char *latin1_output) const noexcept = 0;

  /**
   * Convert valid UTF-8 string into latin1 string.
   *
   * This function assumes that the input string is valid UTF-8 and that it can
   * be represented as Latin1. If you violate this assumption, the result is
   * implementation defined and may include system-dependent behavior such as
   * crashes.
   *
   * This function is for expert users only and not part of our public API. Use
   * convert_utf8_to_latin1 instead.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param latin1_output  the pointer to buffer that can hold conversion result
   * @return the number of written char; 0 if the input was not valid UTF-8
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf8_to_latin1(const char *input, size_t length,
                               char *latin1_output) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
  /**
   * Convert possibly broken UTF-8 string into UTF-16LE string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char16_t; 0 if the input was not valid UTF-8
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf8_to_utf16le(const char *input, size_t length,
                          char16_t *utf16_output) const noexcept = 0;

  /**
   * Convert possibly broken UTF-8 string into UTF-16BE string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char16_t; 0 if the input was not valid UTF-8
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf8_to_utf16be(const char *input, size_t length,
                          char16_t *utf16_output) const noexcept = 0;

  /**
   * Convert possibly broken UTF-8 string into UTF-16LE string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result convert_utf8_to_utf16le_with_errors(
      const char *input, size_t length,
      char16_t *utf16_output) const noexcept = 0;

  /**
   * Convert possibly broken UTF-8 string into UTF-16BE string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of code units validated
   * if successful.
   */
  simdutf_warn_unused virtual result convert_utf8_to_utf16be_with_errors(
      const char *input, size_t length,
      char16_t *utf16_output) const noexcept = 0;
  /**
   * Compute the number of bytes that this UTF-16LE string would require in
   * UTF-8 format even when the UTF-16LE content contains mismatched
   * surrogates that have to be replaced by the replacement character (0xFFFD).
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) where the count is the number of bytes required to
   * encode the UTF-16LE string as UTF-8, and the error code is either SUCCESS
   * or SURROGATE. The count is correct regardless of the error field.
   * When SURROGATE is returned, it does not indicate an error in the case of
   * this function: it indicates that at least one surrogate has been
   * encountered: the surrogates may be matched or not (thus this function does
   * not validate). If the returned error code is SUCCESS, then the input
   * contains no surrogate, is in the Basic Multilingual Plane, and is
   * necessarily valid.
   */
  virtual simdutf_warn_unused result utf8_length_from_utf16le_with_replacement(
      const char16_t *input, size_t length) const noexcept = 0;

  /**
   * Compute the number of bytes that this UTF-16BE string would require in
   * UTF-8 format even when the UTF-16BE content contains mismatched
   * surrogates that have to be replaced by the replacement character (0xFFFD).
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) where the count is the number of bytes required to
   * encode the UTF-16BE string as UTF-8, and the error code is either SUCCESS
   * or SURROGATE. The count is correct regardless of the error field.
   * When SURROGATE is returned, it does not indicate an error in the case of
   * this function: it indicates that at least one surrogate has been
   * encountered: the surrogates may be matched or not (thus this function does
   * not validate). If the returned error code is SUCCESS, then the input
   * contains no surrogate, is in the Basic Multilingual Plane, and is
   * necessarily valid.
   */
  virtual simdutf_warn_unused result utf8_length_from_utf16be_with_replacement(
      const char16_t *input, size_t length) const noexcept = 0;

#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
  /**
   * Convert possibly broken UTF-8 string into UTF-32 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf32_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char16_t; 0 if the input was not valid UTF-8
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf8_to_utf32(const char *input, size_t length,
                        char32_t *utf32_output) const noexcept = 0;

  /**
   * Convert possibly broken UTF-8 string into UTF-32 string and stop on error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf32_buffer  the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char32_t written if
   * successful.
   */
  simdutf_warn_unused virtual result
  convert_utf8_to_utf32_with_errors(const char *input, size_t length,
                                    char32_t *utf32_output) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
  /**
   * Convert valid UTF-8 string into UTF-16LE string.
   *
   * This function assumes that the input string is valid UTF-8.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char16_t
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf8_to_utf16le(const char *input, size_t length,
                                char16_t *utf16_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-8 string into UTF-16BE string.
   *
   * This function assumes that the input string is valid UTF-8.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char16_t
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf8_to_utf16be(const char *input, size_t length,
                                char16_t *utf16_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
  /**
   * Convert valid UTF-8 string into UTF-32 string.
   *
   * This function assumes that the input string is valid UTF-8.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in bytes
   * @param utf16_buffer  the pointer to buffer that can hold conversion result
   * @return the number of written char32_t
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf8_to_utf32(const char *input, size_t length,
                              char32_t *utf32_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
  /**
   * Compute the number of 2-byte code units that this UTF-8 string would
   * require in UTF-16LE format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-8 strings but in such cases the result is implementation defined.
   *
   * @param input         the UTF-8 string to process
   * @param length        the length of the string in bytes
   * @return the number of char16_t code units required to encode the UTF-8
   * string as UTF-16LE
   */
  simdutf_warn_unused virtual size_t
  utf16_length_from_utf8(const char *input, size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
  /**
   * Compute the number of 4-byte code units that this UTF-8 string would
   * require in UTF-32 format.
   *
   * This function is equivalent to count_utf8. It is acceptable to pass invalid
   * UTF-8 strings but in such cases the result is implementation defined.
   *
   * This function does not validate the input.
   *
   * @param input         the UTF-8 string to process
   * @param length        the length of the string in bytes
   * @return the number of char32_t code units required to encode the UTF-8
   * string as UTF-32
   */
  simdutf_warn_unused virtual size_t
  utf32_length_from_utf8(const char *input, size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
  /**
   * Convert possibly broken UTF-16LE string into Latin1 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return number of written code units; 0 if input is not a valid UTF-16LE
   * string or if it cannot be represented as Latin1
   */
  simdutf_warn_unused virtual size_t
  convert_utf16le_to_latin1(const char16_t *input, size_t length,
                            char *latin1_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16BE string into Latin1 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return number of written code units; 0 if input is not a valid UTF-16BE
   * string or if it cannot be represented as Latin1
   */
  simdutf_warn_unused virtual size_t
  convert_utf16be_to_latin1(const char16_t *input, size_t length,
                            char *latin1_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16LE string into Latin1 string.
   * If the string cannot be represented as Latin1, an error
   * is returned.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char written if
   * successful.
   */
  simdutf_warn_unused virtual result
  convert_utf16le_to_latin1_with_errors(const char16_t *input, size_t length,
                                        char *latin1_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16BE string into Latin1 string.
   * If the string cannot be represented as Latin1, an error
   * is returned.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char written if
   * successful.
   */
  simdutf_warn_unused virtual result
  convert_utf16be_to_latin1_with_errors(const char16_t *input, size_t length,
                                        char *latin1_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-16LE string into Latin1 string.
   *
   * This function assumes that the input string is valid UTF-L16LE and that it
   * can be represented as Latin1. If you violate this assumption, the result is
   * implementation defined and may include system-dependent behavior such as
   * crashes.
   *
   * This function is for expert users only and not part of our public API. Use
   * convert_utf16le_to_latin1 instead.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf16le_to_latin1(const char16_t *input, size_t length,
                                  char *latin1_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-16BE string into Latin1 string.
   *
   * This function assumes that the input string is valid UTF16-BE and that it
   * can be represented as Latin1. If you violate this assumption, the result is
   * implementation defined and may include system-dependent behavior such as
   * crashes.
   *
   * This function is for expert users only and not part of our public API. Use
   * convert_utf16be_to_latin1 instead.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf16be_to_latin1(const char16_t *input, size_t length,
                                  char *latin1_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
  /**
   * Convert possibly broken UTF-16LE string into UTF-8 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units; 0 if input is not a valid UTF-16LE
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf16le_to_utf8(const char16_t *input, size_t length,
                          char *utf8_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16BE string into UTF-8 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units; 0 if input is not a valid UTF-16BE
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf16be_to_utf8(const char16_t *input, size_t length,
                          char *utf8_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16LE string into UTF-8 string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char written if
   * successful.
   */
  simdutf_warn_unused virtual result
  convert_utf16le_to_utf8_with_errors(const char16_t *input, size_t length,
                                      char *utf8_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16BE string into UTF-8 string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char written if
   * successful.
   */
  simdutf_warn_unused virtual result
  convert_utf16be_to_utf8_with_errors(const char16_t *input, size_t length,
                                      char *utf8_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16LE string into UTF-8 string, replacing
   * unpaired surrogates with the Unicode replacement character U+FFFD.
   *
   * This function always succeeds: unpaired surrogates are replaced with
   * U+FFFD (3 bytes in UTF-8: 0xEF 0xBF 0xBD).
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units
   */
  simdutf_warn_unused virtual size_t convert_utf16le_to_utf8_with_replacement(
      const char16_t *input, size_t length,
      char *utf8_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16BE string into UTF-8 string, replacing
   * unpaired surrogates with the Unicode replacement character U+FFFD.
   *
   * This function always succeeds: unpaired surrogates are replaced with
   * U+FFFD (3 bytes in UTF-8: 0xEF 0xBF 0xBD).
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units
   */
  simdutf_warn_unused virtual size_t convert_utf16be_to_utf8_with_replacement(
      const char16_t *input, size_t length,
      char *utf8_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-16LE string into UTF-8 string.
   *
   * This function assumes that the input string is valid UTF-16LE.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf16le_to_utf8(const char16_t *input, size_t length,
                                char *utf8_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-16BE string into UTF-8 string.
   *
   * This function assumes that the input string is valid UTF-16BE.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf8_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf16be_to_utf8(const char16_t *input, size_t length,
                                char *utf8_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
  /**
   * Convert possibly broken UTF-16LE string into UTF-32 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf32_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units; 0 if input is not a valid UTF-16LE
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf16le_to_utf32(const char16_t *input, size_t length,
                           char32_t *utf32_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16BE string into UTF-32 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf32_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units; 0 if input is not a valid UTF-16BE
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf16be_to_utf32(const char16_t *input, size_t length,
                           char32_t *utf32_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16LE string into UTF-32 string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf32_buffer   the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char32_t written if
   * successful.
   */
  simdutf_warn_unused virtual result convert_utf16le_to_utf32_with_errors(
      const char16_t *input, size_t length,
      char32_t *utf32_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-16BE string into UTF-32 string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf32_buffer   the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char32_t written if
   * successful.
   */
  simdutf_warn_unused virtual result convert_utf16be_to_utf32_with_errors(
      const char16_t *input, size_t length,
      char32_t *utf32_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-16LE string into UTF-32 string.
   *
   * This function assumes that the input string is valid UTF-16LE.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf32_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf16le_to_utf32(const char16_t *input, size_t length,
                                 char32_t *utf32_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-16LE string into UTF-32BE string.
   *
   * This function assumes that the input string is valid UTF-16BE.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param utf32_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf16be_to_utf32(const char16_t *input, size_t length,
                                 char32_t *utf32_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16
  /**
   * Compute the number of bytes that this UTF-16LE string would require in
   * UTF-8 format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-16 strings but in such cases the result is implementation defined.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return the number of bytes required to encode the UTF-16LE string as UTF-8
   */
  simdutf_warn_unused virtual size_t
  utf8_length_from_utf16le(const char16_t *input,
                           size_t length) const noexcept = 0;

  /**
   * Compute the number of bytes that this UTF-16BE string would require in
   * UTF-8 format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-16 strings but in such cases the result is implementation defined.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return the number of bytes required to encode the UTF-16BE string as UTF-8
   */
  simdutf_warn_unused virtual size_t
  utf8_length_from_utf16be(const char16_t *input,
                           size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1
  /**
   * Convert possibly broken UTF-32 string into Latin1 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return number of written code units; 0 if input is not a valid UTF-32
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf32_to_latin1(const char32_t *input, size_t length,
                          char *latin1_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1
  /**
   * Convert possibly broken UTF-32 string into Latin1 string and stop on error.
   * If the string cannot be represented as Latin1, an error is returned.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param latin1_buffer   the pointer to buffer that can hold conversion
   * result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char written if
   * successful.
   */
  simdutf_warn_unused virtual result
  convert_utf32_to_latin1_with_errors(const char32_t *input, size_t length,
                                      char *latin1_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-32 string into Latin1 string.
   *
   * This function assumes that the input string is valid UTF-32 and can be
   * represented as Latin1. If you violate this assumption, the result is
   * implementation defined and may include system-dependent behavior such as
   * crashes.
   *
   * This function is for expert users only and not part of our public API. Use
   * convert_utf32_to_latin1 instead.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param latin1_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf32_to_latin1(const char32_t *input, size_t length,
                                char *latin1_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
  /**
   * Convert possibly broken UTF-32 string into UTF-8 string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units; 0 if input is not a valid UTF-32
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf32_to_utf8(const char32_t *input, size_t length,
                        char *utf8_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-32 string into UTF-8 string and stop on error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf8_buffer   the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char written if
   * successful.
   */
  simdutf_warn_unused virtual result
  convert_utf32_to_utf8_with_errors(const char32_t *input, size_t length,
                                    char *utf8_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-32 string into UTF-8 string.
   *
   * This function assumes that the input string is valid UTF-32.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf8_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf32_to_utf8(const char32_t *input, size_t length,
                              char *utf8_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
  /**
   * Return the number of bytes that this UTF-16 string would require in Latin1
   * format.
   *
   *
   * @param input         the UTF-16 string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return the number of bytes required to encode the UTF-16 string as Latin1
   */
  simdutf_warn_unused virtual size_t
  utf16_length_from_latin1(size_t length) const noexcept {
    return length;
  }
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
  /**
   * Convert possibly broken UTF-32 string into UTF-16LE string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf16_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units; 0 if input is not a valid UTF-32
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf32_to_utf16le(const char32_t *input, size_t length,
                           char16_t *utf16_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-32 string into UTF-16BE string.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf16_buffer   the pointer to buffer that can hold conversion result
   * @return number of written code units; 0 if input is not a valid UTF-32
   * string
   */
  simdutf_warn_unused virtual size_t
  convert_utf32_to_utf16be(const char32_t *input, size_t length,
                           char16_t *utf16_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-32 string into UTF-16LE string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf16_buffer   the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char16_t written if
   * successful.
   */
  simdutf_warn_unused virtual result convert_utf32_to_utf16le_with_errors(
      const char32_t *input, size_t length,
      char16_t *utf16_buffer) const noexcept = 0;

  /**
   * Convert possibly broken UTF-32 string into UTF-16BE string and stop on
   * error.
   *
   * During the conversion also validation of the input string is done.
   * This function is suitable to work with inputs from untrusted sources.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf16_buffer   the pointer to buffer that can hold conversion result
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in code units) if any, or the number of char16_t written if
   * successful.
   */
  simdutf_warn_unused virtual result convert_utf32_to_utf16be_with_errors(
      const char32_t *input, size_t length,
      char16_t *utf16_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-32 string into UTF-16LE string.
   *
   * This function assumes that the input string is valid UTF-32.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf16_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf32_to_utf16le(const char32_t *input, size_t length,
                                 char16_t *utf16_buffer) const noexcept = 0;

  /**
   * Convert valid UTF-32 string into UTF-16BE string.
   *
   * This function assumes that the input string is valid UTF-32.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @param utf16_buffer   the pointer to a buffer that can hold the conversion
   * result
   * @return number of written code units; 0 if conversion is not possible
   */
  simdutf_warn_unused virtual size_t
  convert_valid_utf32_to_utf16be(const char32_t *input, size_t length,
                                 char16_t *utf16_buffer) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16
  /**
   * Change the endianness of the input. Can be used to go from UTF-16LE to
   * UTF-16BE or from UTF-16BE to UTF-16LE.
   *
   * This function does not validate the input.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16 string to process
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @param output        the pointer to a buffer that can hold the conversion
   * result
   */
  virtual void change_endianness_utf16(const char16_t *input, size_t length,
                                       char16_t *output) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
  /**
   * Return the number of bytes that this Latin1 string would require in UTF-8
   * format.
   *
   * @param input         the Latin1 string to convert
   * @param length        the length of the string bytes
   * @return the number of bytes required to encode the Latin1 string as UTF-8
   */
  simdutf_warn_unused virtual size_t
  utf8_length_from_latin1(const char *input, size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32
  /**
   * Compute the number of bytes that this UTF-32 string would require in UTF-8
   * format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-32 strings but in such cases the result is implementation defined.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @return the number of bytes required to encode the UTF-32 string as UTF-8
   */
  simdutf_warn_unused virtual size_t
  utf8_length_from_utf32(const char32_t *input,
                         size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1
  /**
   * Compute the number of bytes that this UTF-32 string would require in Latin1
   * format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-32 strings but in such cases the result is implementation defined.
   *
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @return the number of bytes required to encode the UTF-32 string as Latin1
   */
  simdutf_warn_unused virtual size_t
  latin1_length_from_utf32(size_t length) const noexcept {
    return length;
  }
#endif // SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1
  /**
   * Compute the number of bytes that this UTF-8 string would require in Latin1
   * format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-8 strings but in such cases the result is implementation defined.
   *
   * @param input         the UTF-8 string to convert
   * @param length        the length of the string in byte
   * @return the number of bytes required to encode the UTF-8 string as Latin1
   */
  simdutf_warn_unused virtual size_t
  latin1_length_from_utf8(const char *input, size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1
  /**
   * Compute the number of bytes that this UTF-16LE/BE string would require in
   * Latin1 format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-16 strings but in such cases the result is implementation defined.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return the number of bytes required to encode the UTF-16LE string as
   * Latin1
   */
  simdutf_warn_unused virtual size_t
  latin1_length_from_utf16(size_t length) const noexcept {
    return length;
  }
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
  /**
   * Compute the number of two-byte code units that this UTF-32 string would
   * require in UTF-16 format.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-32 strings but in such cases the result is implementation defined.
   *
   * @param input         the UTF-32 string to convert
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @return the number of bytes required to encode the UTF-32 string as UTF-16
   */
  simdutf_warn_unused virtual size_t
  utf16_length_from_utf32(const char32_t *input,
                          size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1
  /**
   * Return the number of bytes that this UTF-32 string would require in Latin1
   * format.
   *
   * @param length        the length of the string in 4-byte code units
   * (char32_t)
   * @return the number of bytes required to encode the UTF-32 string as Latin1
   */
  simdutf_warn_unused virtual size_t
  utf32_length_from_latin1(size_t length) const noexcept {
    return length;
  }
#endif // SIMDUTF_FEATURE_UTF32 && SIMDUTF_FEATURE_LATIN1

#if SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32
  /**
   * Compute the number of bytes that this UTF-16LE string would require in
   * UTF-32 format.
   *
   * This function is equivalent to count_utf16le.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-16 strings but in such cases the result is implementation defined.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return the number of bytes required to encode the UTF-16LE string as
   * UTF-32
   */
  simdutf_warn_unused virtual size_t
  utf32_length_from_utf16le(const char16_t *input,
                            size_t length) const noexcept = 0;

  /**
   * Compute the number of bytes that this UTF-16BE string would require in
   * UTF-32 format.
   *
   * This function is equivalent to count_utf16be.
   *
   * This function does not validate the input. It is acceptable to pass invalid
   * UTF-16 strings but in such cases the result is implementation defined.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to convert
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return the number of bytes required to encode the UTF-16BE string as
   * UTF-32
   */
  simdutf_warn_unused virtual size_t
  utf32_length_from_utf16be(const char16_t *input,
                            size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16 && SIMDUTF_FEATURE_UTF32

#if SIMDUTF_FEATURE_UTF16
  /**
   * Count the number of code points (characters) in the string assuming that
   * it is valid.
   *
   * This function assumes that the input string is valid UTF-16LE.
   * It is acceptable to pass invalid UTF-16 strings but in such cases
   * the result is implementation defined.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16LE string to process
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return number of code points
   */
  simdutf_warn_unused virtual size_t
  count_utf16le(const char16_t *input, size_t length) const noexcept = 0;

  /**
   * Count the number of code points (characters) in the string assuming that
   * it is valid.
   *
   * This function assumes that the input string is valid UTF-16BE.
   * It is acceptable to pass invalid UTF-16 strings but in such cases
   * the result is implementation defined.
   *
   * This function is not BOM-aware.
   *
   * @param input         the UTF-16BE string to process
   * @param length        the length of the string in 2-byte code units
   * (char16_t)
   * @return number of code points
   */
  simdutf_warn_unused virtual size_t
  count_utf16be(const char16_t *input, size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF16

#if SIMDUTF_FEATURE_UTF8
  /**
   * Count the number of code points (characters) in the string assuming that
   * it is valid.
   *
   * This function assumes that the input string is valid UTF-8.
   * It is acceptable to pass invalid UTF-8 strings but in such cases
   * the result is implementation defined.
   *
   * @param input         the UTF-8 string to process
   * @param length        the length of the string in bytes
   * @return number of code points
   */
  simdutf_warn_unused virtual size_t
  count_utf8(const char *input, size_t length) const noexcept = 0;
#endif // SIMDUTF_FEATURE_UTF8

#if SIMDUTF_FEATURE_BASE64
  /**
   * Provide the maximal binary length in bytes given the base64 input.
   * As long as the input does not contain ignorable characters (e.g., ASCII
   * spaces or linefeed characters), the result is exact. In particular, the
   * function checks for padding characters.
   *
   * The function is fast (constant time). It checks up to two characters at
   * the end of the string. The input is not otherwise validated or read..
   *
   * @param input         the base64 input to process
   * @param length        the length of the base64 input in bytes
   * @return maximal number of binary bytes
   */
  simdutf_warn_unused size_t maximal_binary_length_from_base64(
      const char *input, size_t length) const noexcept;

  /**
   * Provide the maximal binary length in bytes given the base64 input.
   * As long as the input does not contain ignorable characters (e.g., ASCII
   * spaces or linefeed characters), the result is exact. In particular, the
   * function checks for padding characters.
   *
   * The function is fast (constant time). It checks up to two characters at
   * the end of the string. The input is not otherwise validated or read.
   *
   * @param input         the base64 input to process, in ASCII stored as 16-bit
   * units
   * @param length        the length of the base64 input in 16-bit units
   * @return maximal number of binary bytes
   */
  simdutf_warn_unused size_t maximal_binary_length_from_base64(
      const char16_t *input, size_t length) const noexcept;

  /**
   * Compute the binary length from a base64 input with ASCII spaces.
   * This function is useful for well-formed base64 inputs that may contain
   * ASCII spaces (such as line breaks). For such inputs, the result is exact.
   *
   * The function counts non-whitespace characters (ASCII value > 0x20) and
   * subtracts padding characters ('=') found at the end.
   *
   * @param input         the base64 input to process
   * @param length        the length of the base64 input in bytes
   * @return number of binary bytes
   */
  simdutf_warn_unused virtual size_t
  binary_length_from_base64(const char *input, size_t length) const noexcept;

  /**
   * Compute the binary length from a base64 input with ASCII spaces.
   * This function is useful for well-formed base64 inputs that may contain
   * ASCII spaces (such as line breaks). For such inputs, the result is exact.
   *
   * The function counts non-whitespace characters (ASCII value > 0x20) and
   * subtracts padding characters ('=') found at the end.
   *
   * @param input         the base64 input to process, in ASCII stored as 16-bit
   * units
   * @param length        the length of the base64 input in 16-bit units
   * @return number of binary bytes
   */
  simdutf_warn_unused virtual size_t
  binary_length_from_base64(const char16_t *input,
                            size_t length) const noexcept;

  /**
   * Convert a base64 input to a binary output.
   *
   * This function follows the WHATWG forgiving-base64 format, which means that
   * it will ignore any ASCII spaces in the input. You may provide a padded
   * input (with one or two equal signs at the end) or an unpadded input
   * (without any equal signs at the end).
   *
   * See https://infra.spec.whatwg.org/#forgiving-base64-decode
   *
   * This function will fail in case of invalid input. When last_chunk_options =
   * loose, there are two possible reasons for failure: the input contains a
   * number of base64 characters that when divided by 4, leaves a single
   * remainder character (BASE64_INPUT_REMAINDER), or the input contains a
   * character that is not a valid base64 character (INVALID_BASE64_CHARACTER).
   *
   * You should call this function with a buffer that is at least
   * maximal_binary_length_from_base64(input, length) bytes long. If you fail to
   * provide that much space, the function may cause a buffer overflow.
   *
   * @param input         the base64 string to process
   * @param length        the length of the string in bytes
   * @param output        the pointer to a buffer that can hold the conversion
   * result (should be at least maximal_binary_length_from_base64(input, length)
   * bytes long).
   * @param options       the base64 options to use, can be base64_default or
   * base64_url, is base64_default by default.
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and either position of the error
   * (in the input in bytes) if any, or the number of bytes written if
   * successful.
   */
  simdutf_warn_unused virtual result
  base64_to_binary(const char *input, size_t length, char *output,
                   base64_options options = base64_default,
                   last_chunk_handling_options last_chunk_options =
                       last_chunk_handling_options::loose) const noexcept = 0;

  /**
   * Convert a base64 input to a binary output while returning more details
   * than base64_to_binary.
   *
   * This function follows the WHATWG forgiving-base64 format, which means that
   * it will ignore any ASCII spaces in the input. You may provide a padded
   * input (with one or two equal signs at the end) or an unpadded input
   * (without any equal signs at the end).
   *
   * See https://infra.spec.whatwg.org/#forgiving-base64-decode
   *
   * This function will fail in case of invalid input. When last_chunk_options =
   * loose, there are two possible reasons for failure: the input contains a
   * number of base64 characters that when divided by 4, leaves a single
   * remainder character (BASE64_INPUT_REMAINDER), or the input contains a
   * character that is not a valid base64 character (INVALID_BASE64_CHARACTER).
   *
   * You should call this function with a buffer that is at least
   * maximal_binary_length_from_base64(input, length) bytes long. If you fail to
   * provide that much space, the function may cause a buffer overflow.
   *
   * @param input         the base64 string to process
   * @param length        the length of the string in bytes
   * @param output        the pointer to a buffer that can hold the conversion
   * result (should be at least maximal_binary_length_from_base64(input, length)
   * bytes long).
   * @param options       the base64 options to use, can be base64_default or
   * base64_url, is base64_default by default.
   * @return a full_result pair struct (of type simdutf::result containing the
   * three fields error, input_count and output_count).
   */
  simdutf_warn_unused virtual full_result base64_to_binary_details(
      const char *input, size_t length, char *output,
      base64_options options = base64_default,
      last_chunk_handling_options last_chunk_options =
          last_chunk_handling_options::loose) const noexcept = 0;

  /**
   * Convert a base64 input to a binary output.
   *
   * This function follows the WHATWG forgiving-base64 format, which means that
   * it will ignore any ASCII spaces in the input. You may provide a padded
   * input (with one or two equal signs at the end) or an unpadded input
   * (without any equal signs at the end).
   *
   * See https://infra.spec.whatwg.org/#forgiving-base64-decode
   *
   * This function will fail in case of invalid input. When last_chunk_options =
   * loose, there are two possible reasons for failure: the input contains a
   * number of base64 characters that when divided by 4, leaves a single
   * remainder character (BASE64_INPUT_REMAINDER), or the input contains a
   * character that is not a valid base64 character (INVALID_BASE64_CHARACTER).
   *
   * You should call this function with a buffer that is at least
   * maximal_binary_length_from_base64(input, length) bytes long. If you
   * fail to provide that much space, the function may cause a buffer overflow.
   *
   * @param input         the base64 string to process, in ASCII stored as
   * 16-bit units
   * @param length        the length of the string in 16-bit units
   * @param output        the pointer to a buffer that can hold the conversion
   * result (should be at least maximal_binary_length_from_base64(input, length)
   * bytes long).
   * @param options       the base64 options to use, can be base64_default or
   * base64_url, is base64_default by default.
   * @return a result pair struct (of type simdutf::result containing the two
   * fields error and count) with an error code and position of the
   * INVALID_BASE64_CHARACTER error (in the input in units) if any, or the
   * number of bytes written if successful.
   */
  simdutf_warn_unused virtual result
  base64_to_binary(const char16_t *input, size_t length, char *output,
                   base64_options options = base64_default,
                   last_chunk_handling_options last_chunk_options =
                       last_chunk_handling_options::loose) const noexcept = 0;

  /**
   * Convert a base64 input to a binary output while returning more details
   * than base64_to_binary.
   *
   * This function follows the WHATWG forgiving-base64 format, which means that
   * it will ignore any ASCII spaces in the input. You may provide a padded
   * input (with one or two equal signs at the end) or an unpadded input
   * (without any equal signs at the end).
   *
   * See https://infra.spec.whatwg.org/#forgiving-base64-decode
   *
   * This function will fail in case of invalid input. When last_chunk_options =
   * loose, there are two possible reasons for failure: the input contains a
   * number of base64 characters that when divided by 4, leaves a single
   * remainder character (BASE64_INPUT_REMAINDER), or the input contains a
   * character that is not a valid base64 character (INVALID_BASE64_CHARACTER).
   *
   * You should call this function with a buffer that is at least
   * maximal_binary_length_from_base64(input, length) bytes long. If you fail to
   * provide that much space, the function may cause a buffer overflow.
   *
   * @param input         the base64 string to process
   * @param length        the length of the string in bytes
   * @param output        the pointer to a buffer that can hold the conversion
   * result (should be at least maximal_binary_length_from_base64(input, length)
   * bytes long).
   * @param options       the base64 options to use, can be base64_default or
   * base64_url, is base64_default by default.
   * @return a full_result pair struct (of type simdutf::result containing the
   * three fields error, input_count and output_count).
   */
  simdutf_warn_unused virtual full_result base64_to_binary_details(
      const char16_t *input, size_t length, char *output,
      base64_options options = base64_default,
      last_chunk_handling_options last_chunk_options =
          last_chunk_handling_options::loose) const noexcept = 0;

  /**
   * Provide the base64 length in bytes given the length of a binary input.
   *
   * @param length        the length of the input in bytes
   * @param options       the base64 options to use, can be base64_default or
   * base64_url, is base64_default by default.
   * @return number of base64 bytes
   */
  simdutf_warn_unused size_t base64_length_from_binary(
      size_t length, base64_options options = base64_default) const noexcept;

  /**
   * Convert a binary input to a base64 output.
   *
   * The default option (simdutf::base64_default) uses the characters `+` and
   * `/` as part of its alphabet. Further, it adds padding (`=`) at the end of
   * the output to ensure that the output length is a multiple of four.
   *
   * The URL option (simdutf::base64_url) uses the characters `-` and `_` as
   * part of its alphabet. No padding is added at the end of the output.
   *
   * This function always succeeds.
   *
   * @param input         the binary to process
   * @param length        the length of the input in bytes
   * @param output        the pointer to a buffer that can hold the conversion
   * result (should be at least base64_length_from_binary(length) bytes long)
   * @param options       the base64 options to use, can be base64_default or
   * base64_url, is base64_default by default.
   * @return number of written bytes, will be equal to
   * base64_length_from_binary(length, options)
   */
  virtual size_t
  binary_to_base64(const char *input, size_t length, char *output,
                   base64_options options = base64_default) const noexcept = 0;

  /**
   * Convert a binary input to a base64 output with lines of given length.
   * Lines are separated by a single linefeed character.
   *
   * The default option (simdutf::base64_default) uses the characters `+` and
   * `/` as part of its alphabet. Further, it adds padding (`=`) at the end of
   * the output to ensure that the output length is a multiple of four.
   *
   * The URL option (simdutf::base64_url) uses the characters `-` and `_` as
   * part of its alphabet. No padding is added at the end of the output.
   *
   * This function always succeeds.
   *
   * @param input         the binary to process
   * @param length        the length of the input in bytes
   * @param output        the pointer to a buffer that can hold the conversion
   * result (should be at least base64_length_from_binary_with_lines(length,
   * options, line_length) bytes long)
   * @param line_length   the length of each line, values smaller than 4 are
   * interpreted as 4
   * @param options       the base64 options to use, can be base64_default or
   * base64_url, is base64_default by default.
   * @return number of written bytes, will be equal to
   * base64_length_from_binary_with_lines(length, options, line_length)
   */
  virtual size_t binary_to_base64_with_lines(
      const char *input, size_t length, char *output,
      size_t line_length = simdutf::default_line_length,
      base64_options options = base64_default) const noexcept = 0;

  /**
   * Find the first occurrence of a character in a string. If the character is
   * not found, return a pointer to the end of the string.
   * @param start        the start of the string
   * @param end          the end of the string
   * @param character    the character to find
   * @return a pointer to the first occurrence of the character in the string,
   * or a pointer to the end of the string if the character is not found.
   *
   */
  virtual const char *find(const char *start, const char *end,
                           char character) const noexcept = 0;
  virtual const char16_t *find(const char16_t *start, const char16_t *end,
                               char16_t character) const noexcept = 0;
#endif // SIMDUTF_FEATURE_BASE64

#ifdef SIMDUTF_INTERNAL_TESTS
  // This method is exported only in developer mode, its purpose
  // is to expose some internal test procedures from the given
  // implementation and then use them through our standard test
  // framework.
  //
  // Regular users should not use it, the tests of the public
  // API are enough.

  struct TestProcedure {
    // display name
    std::string name;

    // procedure should return whether given test pass or not
    void (*procedure)(const implementation &);
  };

  virtual std::vector<TestProcedure> internal_tests() const;
#endif

protected:
  /** @private Construct an implementation with the given name and description.
   * For subclasses. */
  simdutf_really_inline implementation(const char *name,
                                       const char *description,
                                       uint32_t required_instruction_sets)
      : _name(name), _description(description),
        _required_instruction_sets(required_instruction_sets) {}

protected:
  ~implementation() = default;

private:
  /**
   * The name of this implementation.
   */
  const char *_name;

  /**
   * The description of this implementation.
   */
  const char *_description;

  /**
   * Instruction sets required for this implementation.
   */
  const uint32_t _required_instruction_sets;
};

/** @private */
namespace internal {

/**
 * The list of available implementations compiled into simdutf.
 */
class available_implementation_list {
public:
  /** Get the list of available implementations compiled into simdutf */
  simdutf_really_inline available_implementation_list() {}
  /** Number of implementations */
  size_t size() const noexcept;
  /** STL const begin() iterator */
  const implementation *const *begin() const noexcept;
  /** STL const end() iterator */
  const implementation *const *end() const noexcept;

  /**
   * Get the implementation with the given name.
   *
   * Case sensitive.
   *
   *     const implementation *impl =
   * simdutf::available_implementations["westmere"]; if (!impl) { exit(1); } if
   * (!imp->supported_by_runtime_system()) { exit(1); }
   *     simdutf::active_implementation = impl;
   *
   * @param name the implementation to find, e.g. "westmere", "haswell", "arm64"
   * @return the implementation, or nullptr if the parse failed.
   */
  const implementation *operator[](const std::string &name) const noexcept {
    for (const implementation *impl : *this) {
      if (impl->name() == name) {
        return impl;
      }
    }
    return nullptr;
  }

  /**
   * Detect the most advanced implementation supported by the current host.
   *
   * This is used to initialize the implementation on startup.
   *
   *     const implementation *impl =
   * simdutf::available_implementation::detect_best_supported();
   *     simdutf::active_implementation = impl;
   *
   * @return the most advanced supported implementation for the current host, or
   * an implementation that returns UNSUPPORTED_ARCHITECTURE if there is no
   * supported implementation. Will never return nullptr.
   */
  const implementation *detect_best_supported() const noexcept;
};

template <typename T> class atomic_ptr {
public:
  atomic_ptr(T *_ptr) : ptr{_ptr} {}

#if defined(SIMDUTF_NO_THREADS)
  operator const T *() const { return ptr; }
  const T &operator*() const { return *ptr; }
  const T *operator->() const { return ptr; }

  operator T *() { return ptr; }
  T &operator*() { return *ptr; }
  T *operator->() { return ptr; }
  atomic_ptr &operator=(T *_ptr) {
    ptr = _ptr;
    return *this;
  }

#else
  operator const T *() const { return ptr.load(); }
  const T &operator*() const { return *ptr; }
  const T *operator->() const { return ptr.load(); }

  operator T *() { return ptr.load(); }
  T &operator*() { return *ptr; }
  T *operator->() { return ptr.load(); }
  atomic_ptr &operator=(T *_ptr) {
    ptr = _ptr;
    return *this;
  }

#endif

private:
#if defined(SIMDUTF_NO_THREADS)
  T *ptr;
#else
  std::atomic<T *> ptr;
#endif
};

class detect_best_supported_implementation_on_first_use;

} // namespace internal

/**
 * The list of available implementations compiled into simdutf.
 */
extern SIMDUTF_DLLIMPORTEXPORT const internal::available_implementation_list &
get_available_implementations();

/**
 * The active implementation.
 *
 * Automatically initialized on first use to the most advanced implementation
 * supported by this hardware.
 */
extern SIMDUTF_DLLIMPORTEXPORT internal::atomic_ptr<const implementation> &
get_active_implementation();

} // namespace simdutf

#if SIMDUTF_FEATURE_BASE64
  // this header is not part of the public api
  #include <simdutf/base64_implementation.h>

namespace simdutf {
  #if SIMDUTF_SPAN
/**
 * @brief span overload
 * @return a tuple of result and outlen
 */
simdutf_really_inline
    simdutf_constexpr23 simdutf_warn_unused std::tuple<result, std::size_t>
    base64_to_binary_safe(
        const detail::input_span_of_byte_like auto &input,
        detail::output_span_of_byte_like auto &&binary_output,
        base64_options options = base64_default,
        last_chunk_handling_options last_chunk_options = loose,
        bool decode_up_to_bad_char = false) noexcept {
  size_t outlen = binary_output.size();
    #if SIMDUTF_CPLUSPLUS23
  if consteval {
    using CInput = std::decay_t<decltype(*input.data())>;
    static_assert(std::is_same_v<CInput, char>,
                  "sorry, the constexpr implementation is for now limited to "
                  "input of type char");
    using COutput = std::decay_t<decltype(*binary_output.data())>;
    static_assert(std::is_same_v<COutput, char>,
                  "sorry, the constexpr implementation is for now limited to "
                  "output of type char");
    auto r = base64_to_binary_safe_impl(
        input.data(), input.size(), binary_output.data(), outlen, options,
        last_chunk_options, decode_up_to_bad_char);
    return {r, outlen};
  } else
    #endif
  {
    auto r = base64_to_binary_safe_impl<char>(
        reinterpret_cast<const char *>(input.data()), input.size(),
        reinterpret_cast<char *>(binary_output.data()), outlen, options,
        last_chunk_options, decode_up_to_bad_char);
    return {r, outlen};
  }
}

    #if SIMDUTF_SPAN
/**
 * @brief span overload
 * @return a tuple of result and outlen
 */
simdutf_really_inline
    simdutf_warn_unused simdutf_constexpr23 std::tuple<result, std::size_t>
    base64_to_binary_safe(
        std::span<const char16_t> input,
        detail::output_span_of_byte_like auto &&binary_output,
        base64_options options = base64_default,
        last_chunk_handling_options last_chunk_options = loose,
        bool decode_up_to_bad_char = false) noexcept {
  size_t outlen = binary_output.size();
      #if SIMDUTF_CPLUSPLUS23
  if consteval {
    auto r = base64_to_binary_safe_impl(
        input.data(), input.size(), binary_output.data(), outlen, options,
        last_chunk_options, decode_up_to_bad_char);
    return {r, outlen};
  } else
      #endif
  {
    auto r = base64_to_binary_safe(
        input.data(), input.size(),
        reinterpret_cast<char *>(binary_output.data()), outlen, options,
        last_chunk_options, decode_up_to_bad_char);
    return {r, outlen};
  }
}
    #endif // SIMDUTF_SPAN

  #endif // SIMDUTF_SPAN
} // namespace simdutf

#endif // SIMDUTF_FEATURE_BASE64

#endif // SIMDUTF_IMPLEMENTATION_H
