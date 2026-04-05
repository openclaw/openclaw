#ifndef SIMDUTF_UTF16_H
#define SIMDUTF_UTF16_H

namespace simdutf {
namespace scalar {
namespace utf16 {

template <endianness big_endian>
simdutf_warn_unused simdutf_constexpr23 bool
validate_as_ascii(const char16_t *data, size_t len) noexcept {
  for (size_t pos = 0; pos < len; pos++) {
    char16_t word = scalar::utf16::swap_if_needed<big_endian>(data[pos]);
    if (word >= 0x80) {
      return false;
    }
  }
  return true;
}

template <endianness big_endian>
inline simdutf_warn_unused simdutf_constexpr23 bool
validate(const char16_t *data, size_t len) noexcept {
  uint64_t pos = 0;
  while (pos < len) {
    char16_t word = scalar::utf16::swap_if_needed<big_endian>(data[pos]);
    if ((word & 0xF800) == 0xD800) {
      if (pos + 1 >= len) {
        return false;
      }
      char16_t diff = char16_t(word - 0xD800);
      if (diff > 0x3FF) {
        return false;
      }
      char16_t next_word = !match_system(big_endian)
                               ? u16_swap_bytes(data[pos + 1])
                               : data[pos + 1];
      char16_t diff2 = char16_t(next_word - 0xDC00);
      if (diff2 > 0x3FF) {
        return false;
      }
      pos += 2;
    } else {
      pos++;
    }
  }
  return true;
}

template <endianness big_endian>
inline simdutf_warn_unused simdutf_constexpr23 result
validate_with_errors(const char16_t *data, size_t len) noexcept {
  size_t pos = 0;
  while (pos < len) {
    char16_t word = scalar::utf16::swap_if_needed<big_endian>(data[pos]);
    if ((word & 0xF800) == 0xD800) {
      if (pos + 1 >= len) {
        return result(error_code::SURROGATE, pos);
      }
      char16_t diff = char16_t(word - 0xD800);
      if (diff > 0x3FF) {
        return result(error_code::SURROGATE, pos);
      }
      char16_t next_word = !match_system(big_endian)
                               ? u16_swap_bytes(data[pos + 1])
                               : data[pos + 1];
      char16_t diff2 = uint16_t(next_word - 0xDC00);
      if (diff2 > 0x3FF) {
        return result(error_code::SURROGATE, pos);
      }
      pos += 2;
    } else {
      pos++;
    }
  }
  return result(error_code::SUCCESS, pos);
}

template <endianness big_endian>
simdutf_constexpr23 size_t count_code_points(const char16_t *p, size_t len) {
  // We are not BOM aware.
  size_t counter{0};
  for (size_t i = 0; i < len; i++) {
    char16_t word = scalar::utf16::swap_if_needed<big_endian>(p[i]);
    counter += ((word & 0xFC00) != 0xDC00);
  }
  return counter;
}

template <endianness big_endian>
simdutf_constexpr23 size_t utf8_length_from_utf16(const char16_t *p,
                                                  size_t len) {
  // We are not BOM aware.
  size_t counter{0};
  for (size_t i = 0; i < len; i++) {
    char16_t word = scalar::utf16::swap_if_needed<big_endian>(p[i]);
    counter++; // ASCII
    counter += static_cast<size_t>(
        word >
        0x7F); // non-ASCII is at least 2 bytes, surrogates are 2*2 == 4 bytes
    counter += static_cast<size_t>((word > 0x7FF && word <= 0xD7FF) ||
                                   (word >= 0xE000)); // three-byte
  }
  return counter;
}

template <endianness big_endian>
simdutf_constexpr23 size_t utf32_length_from_utf16(const char16_t *p,
                                                   size_t len) {
  // We are not BOM aware.
  size_t counter{0};
  for (size_t i = 0; i < len; i++) {
    char16_t word = scalar::utf16::swap_if_needed<big_endian>(p[i]);
    counter += ((word & 0xFC00) != 0xDC00);
  }
  return counter;
}

simdutf_really_inline simdutf_constexpr23 void
change_endianness_utf16(const char16_t *input, size_t size, char16_t *output) {
  for (size_t i = 0; i < size; i++) {
    *output++ = char16_t(input[i] >> 8 | input[i] << 8);
  }
}

template <endianness big_endian>
simdutf_warn_unused simdutf_constexpr23 size_t
trim_partial_utf16(const char16_t *input, size_t length) {
  if (length == 0) {
    return 0;
  }
  uint16_t last_word = uint16_t(input[length - 1]);
  last_word = scalar::utf16::swap_if_needed<big_endian>(last_word);
  length -= ((last_word & 0xFC00) == 0xD800);
  return length;
}

template <endianness big_endian>
simdutf_constexpr bool is_high_surrogate(char16_t c) {
  c = scalar::utf16::swap_if_needed<big_endian>(c);
  return (0xd800 <= c && c <= 0xdbff);
}

template <endianness big_endian>
simdutf_constexpr bool is_low_surrogate(char16_t c) {
  c = scalar::utf16::swap_if_needed<big_endian>(c);
  return (0xdc00 <= c && c <= 0xdfff);
}

simdutf_really_inline constexpr bool high_surrogate(char16_t c) {
  return (0xd800 <= c && c <= 0xdbff);
}

simdutf_really_inline constexpr bool low_surrogate(char16_t c) {
  return (0xdc00 <= c && c <= 0xdfff);
}

template <endianness big_endian>
simdutf_constexpr23 result
utf8_length_from_utf16_with_replacement(const char16_t *p, size_t len) {
  bool any_surrogates = false;
  // We are not BOM aware.
  size_t counter{0};
  for (size_t i = 0; i < len; i++) {
    if (is_high_surrogate<big_endian>(p[i])) {
      any_surrogates = true;
      // surrogate pair
      if (i + 1 < len && is_low_surrogate<big_endian>(p[i + 1])) {
        counter += 4;
        i++; // skip low surrogate
      } else {
        counter += 3; // unpaired high surrogate replaced by U+FFFD
      }
      continue;
    } else if (is_low_surrogate<big_endian>(p[i])) {
      any_surrogates = true;
      counter += 3; // unpaired low surrogate replaced by U+FFFD
      continue;
    }
    char16_t word = !match_system(big_endian) ? u16_swap_bytes(p[i]) : p[i];
    counter++; // at least 1 byte
    counter +=
        static_cast<size_t>(word > 0x7F); // non-ASCII is at least 2 bytes
    counter += static_cast<size_t>(word > 0x7FF); // three-byte
  }
  return {any_surrogates ? error_code::SURROGATE : error_code::SUCCESS,
          counter};
}

// variable templates are a C++14 extension
template <endianness big_endian> constexpr char16_t replacement() {
  return !match_system(big_endian) ? scalar::u16_swap_bytes(0xfffd) : 0xfffd;
}

template <endianness big_endian>
simdutf_constexpr23 void to_well_formed_utf16(const char16_t *input, size_t len,
                                              char16_t *output) {
  const char16_t replacement = utf16::replacement<big_endian>();
  bool high_surrogate_prev = false, high_surrogate, low_surrogate;
  size_t i = 0;
  for (; i < len; i++) {
    char16_t c = input[i];
    high_surrogate = is_high_surrogate<big_endian>(c);
    low_surrogate = is_low_surrogate<big_endian>(c);
    if (high_surrogate_prev && !low_surrogate) {
      output[i - 1] = replacement;
    }

    if (!high_surrogate_prev && low_surrogate) {
      output[i] = replacement;
    } else {
      output[i] = input[i];
    }
    high_surrogate_prev = high_surrogate;
  }

  /* string may not end with high surrogate */
  if (high_surrogate_prev) {
    output[i - 1] = replacement;
  }
}

} // namespace utf16
} // namespace scalar
} // namespace simdutf

#endif
