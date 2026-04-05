#ifndef SIMDUTF_ENCODING_TYPES_H
#define SIMDUTF_ENCODING_TYPES_H
#include <string>
#include "simdutf/portability.h"
#include "simdutf/common_defs.h"

#if !defined(SIMDUTF_NO_STD_TEXT_ENCODING) &&                                  \
    defined(__cpp_lib_text_encoding) && __cpp_lib_text_encoding >= 202306L
  #define SIMDUTF_HAS_STD_TEXT_ENCODING 1
  #include <text_encoding>
#endif

namespace simdutf {

enum encoding_type {
  UTF8 = 1,      // BOM 0xef 0xbb 0xbf
  UTF16_LE = 2,  // BOM 0xff 0xfe
  UTF16_BE = 4,  // BOM 0xfe 0xff
  UTF32_LE = 8,  // BOM 0xff 0xfe 0x00 0x00
  UTF32_BE = 16, // BOM 0x00 0x00 0xfe 0xff
  Latin1 = 32,

  unspecified = 0
};

#ifndef SIMDUTF_IS_BIG_ENDIAN
  #error "SIMDUTF_IS_BIG_ENDIAN needs to be defined."
#endif

enum endianness {
  LITTLE = 0,
  BIG = 1,
  NATIVE =
#if SIMDUTF_IS_BIG_ENDIAN
      BIG
#else
      LITTLE
#endif
};

simdutf_warn_unused simdutf_really_inline constexpr bool
match_system(endianness e) {
  return e == endianness::NATIVE;
}

simdutf_warn_unused std::string to_string(encoding_type bom);

// Note that BOM for UTF8 is discouraged.
namespace BOM {

/**
 * Checks for a BOM. If not, returns unspecified
 * @param input         the string to process
 * @param length        the length of the string in code units
 * @return the corresponding encoding
 */

simdutf_warn_unused encoding_type check_bom(const uint8_t *byte, size_t length);
simdutf_warn_unused encoding_type check_bom(const char *byte, size_t length);
/**
 * Returns the size, in bytes, of the BOM for a given encoding type.
 * Note that UTF8 BOM are discouraged.
 * @param bom         the encoding type
 * @return the size in bytes of the corresponding BOM
 */
simdutf_warn_unused size_t bom_byte_size(encoding_type bom);

} // namespace BOM

#ifdef SIMDUTF_HAS_STD_TEXT_ENCODING
/**
 * Convert a simdutf encoding type to a std::text_encoding.
 *
 * @param enc  the simdutf encoding type
 * @return     the corresponding std::text_encoding, or
 *             std::text_encoding::id::unknown for unspecified/unsupported
 */
simdutf_warn_unused constexpr std::text_encoding
to_std_encoding(encoding_type enc) noexcept {
  switch (enc) {
  case UTF8:
    return std::text_encoding(std::text_encoding::id::UTF8);
  case UTF16_LE:
    return std::text_encoding(std::text_encoding::id::UTF16LE);
  case UTF16_BE:
    return std::text_encoding(std::text_encoding::id::UTF16BE);
  case UTF32_LE:
    return std::text_encoding(std::text_encoding::id::UTF32LE);
  case UTF32_BE:
    return std::text_encoding(std::text_encoding::id::UTF32BE);
  case Latin1:
    return std::text_encoding(std::text_encoding::id::ISOLatin1);
  case unspecified:
  default:
    return std::text_encoding(std::text_encoding::id::unknown);
  }
}

/**
 * Convert a std::text_encoding to a simdutf encoding type.
 *
 * @param enc  the std::text_encoding
 * @return     the corresponding simdutf encoding type, or
 *             encoding_type::unspecified if the encoding is not supported
 */
simdutf_warn_unused constexpr encoding_type
from_std_encoding(const std::text_encoding &enc) noexcept {
  switch (enc.mib()) {
  case std::text_encoding::id::UTF8:
    return UTF8;
  case std::text_encoding::id::UTF16LE:
    return UTF16_LE;
  case std::text_encoding::id::UTF16BE:
    return UTF16_BE;
  case std::text_encoding::id::UTF32LE:
    return UTF32_LE;
  case std::text_encoding::id::UTF32BE:
    return UTF32_BE;
  case std::text_encoding::id::ISOLatin1:
    return Latin1;
  default:
    return unspecified;
  }
}

/**
 * Get the native-endian UTF-16 encoding type for this system.
 *
 * @return UTF16_LE on little-endian systems, UTF16_BE on big-endian systems
 */
simdutf_warn_unused constexpr encoding_type native_utf16_encoding() noexcept {
  #if SIMDUTF_IS_BIG_ENDIAN
  return UTF16_BE;
  #else
  return UTF16_LE;
  #endif
}

/**
 * Get the native-endian UTF-32 encoding type for this system.
 *
 * @return UTF32_LE on little-endian systems, UTF32_BE on big-endian systems
 */
simdutf_warn_unused constexpr encoding_type native_utf32_encoding() noexcept {
  #if SIMDUTF_IS_BIG_ENDIAN
  return UTF32_BE;
  #else
  return UTF32_LE;
  #endif
}

/**
 * Convert a std::text_encoding to a simdutf encoding type,
 * using native endianness for UTF-16/UTF-32 without explicit endianness.
 *
 * When the input is std::text_encoding::id::UTF16 or UTF32 (without LE/BE
 * suffix), this returns the native-endian simdutf variant.
 *
 * @param enc  the std::text_encoding
 * @return     the corresponding simdutf encoding type, or
 *             encoding_type::unspecified if the encoding is not supported
 */
simdutf_warn_unused constexpr encoding_type
from_std_encoding_native(const std::text_encoding &enc) noexcept {
  switch (enc.mib()) {
  case std::text_encoding::id::UTF8:
    return UTF8;
  case std::text_encoding::id::UTF16:
    return native_utf16_encoding();
  case std::text_encoding::id::UTF16LE:
    return UTF16_LE;
  case std::text_encoding::id::UTF16BE:
    return UTF16_BE;
  case std::text_encoding::id::UTF32:
    return native_utf32_encoding();
  case std::text_encoding::id::UTF32LE:
    return UTF32_LE;
  case std::text_encoding::id::UTF32BE:
    return UTF32_BE;
  case std::text_encoding::id::ISOLatin1:
    return Latin1;
  default:
    return unspecified;
  }
}
#endif // SIMDUTF_HAS_STD_TEXT_ENCODING

} // namespace simdutf
#endif
