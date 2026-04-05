#ifndef SIMDUTF_LATIN1_TO_UTF8_H
#define SIMDUTF_LATIN1_TO_UTF8_H

namespace simdutf {
namespace scalar {
namespace {
namespace latin1_to_utf8 {

template <typename InputPtr, typename OutputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires(simdutf::detail::indexes_into_byte_like<InputPtr> &&
           simdutf::detail::index_assignable_from_char<OutputPtr>)
#endif
simdutf_constexpr23 size_t convert(InputPtr data, size_t len,
                                   OutputPtr utf8_output) {
  // const unsigned char *data = reinterpret_cast<const unsigned char *>(buf);
  size_t pos = 0;
  size_t utf8_pos = 0;

  while (pos < len) {
#if SIMDUTF_CPLUSPLUS23
    if !consteval
#endif
    {
      // try to convert the next block of 16 ASCII bytes
      if (pos + 16 <= len) { // if it is safe to read 16 more bytes, check that
                             // they are ascii
        uint64_t v1;
        ::memcpy(&v1, data + pos, sizeof(uint64_t));
        uint64_t v2;
        ::memcpy(&v2, data + pos + sizeof(uint64_t), sizeof(uint64_t));
        uint64_t v{v1 |
                   v2}; // We are only interested in these bits: 1000 1000 1000
                        // 1000, so it makes sense to concatenate everything
        if ((v & 0x8080808080808080) ==
            0) { // if NONE of these are set, e.g. all of them are zero, then
                 // everything is ASCII
          size_t final_pos = pos + 16;
          while (pos < final_pos) {
            utf8_output[utf8_pos++] = char(data[pos]);
            pos++;
          }
          continue;
        }
      } // if (pos + 16 <= len)
    } // !consteval scope

    unsigned char byte = data[pos];
    if ((byte & 0x80) == 0) { // if ASCII
      // will generate one UTF-8 bytes
      utf8_output[utf8_pos++] = char(byte);
      pos++;
    } else {
      // will generate two UTF-8 bytes
      utf8_output[utf8_pos++] = char((byte >> 6) | 0b11000000);
      utf8_output[utf8_pos++] = char((byte & 0b111111) | 0b10000000);
      pos++;
    }
  } // while
  return utf8_pos;
}

simdutf_really_inline size_t convert(const char *buf, size_t len,
                                     char *utf8_output) {
  return convert(reinterpret_cast<const unsigned char *>(buf), len,
                 utf8_output);
}

inline size_t convert_safe(const char *buf, size_t len, char *utf8_output,
                           size_t utf8_len) {
  const unsigned char *data = reinterpret_cast<const unsigned char *>(buf);
  size_t pos = 0;
  size_t skip_pos = 0;
  size_t utf8_pos = 0;
  while (pos < len && utf8_pos < utf8_len) {
    // try to convert the next block of 16 ASCII bytes
    if (pos >= skip_pos && pos + 16 <= len &&
        utf8_pos + 16 <= utf8_len) { // if it is safe to read 16 more bytes,
                                     // check that they are ascii
      uint64_t v1;
      ::memcpy(&v1, data + pos, sizeof(uint64_t));
      uint64_t v2;
      ::memcpy(&v2, data + pos + sizeof(uint64_t), sizeof(uint64_t));
      uint64_t v{v1 |
                 v2}; // We are only interested in these bits: 1000 1000 1000
                      // 1000, so it makes sense to concatenate everything
      if ((v & 0x8080808080808080) ==
          0) { // if NONE of these are set, e.g. all of them are zero, then
               // everything is ASCII
        ::memcpy(utf8_output + utf8_pos, buf + pos, 16);
        utf8_pos += 16;
        pos += 16;
      } else {
        // At least one of the next 16 bytes are not ASCII, we will process them
        // one by one
        skip_pos = pos + 16;
      }
    } else {
      const auto byte = data[pos];
      if ((byte & 0x80) == 0) { // if ASCII
        // will generate one UTF-8 bytes
        utf8_output[utf8_pos++] = char(byte);
        pos++;
      } else if (utf8_pos + 2 <= utf8_len) {
        // will generate two UTF-8 bytes
        utf8_output[utf8_pos++] = char((byte >> 6) | 0b11000000);
        utf8_output[utf8_pos++] = char((byte & 0b111111) | 0b10000000);
        pos++;
      } else {
        break;
      }
    }
  }
  return utf8_pos;
}

template <typename InputPtr, typename OutputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires(simdutf::detail::indexes_into_byte_like<InputPtr> &&
           simdutf::detail::index_assignable_from_char<OutputPtr>)
#endif
simdutf_constexpr23 size_t convert_safe_constexpr(InputPtr data, size_t len,
                                                  OutputPtr utf8_output,
                                                  size_t utf8_len) {
  size_t pos = 0;
  size_t utf8_pos = 0;
  while (pos < len && utf8_pos < utf8_len) {
    const unsigned char byte = data[pos];
    if ((byte & 0x80) == 0) { // if ASCII
      // will generate one UTF-8 bytes
      utf8_output[utf8_pos++] = char(byte);
      pos++;
    } else if (utf8_pos + 2 <= utf8_len) {
      // will generate two UTF-8 bytes
      utf8_output[utf8_pos++] = char((byte >> 6) | 0b11000000);
      utf8_output[utf8_pos++] = char((byte & 0b111111) | 0b10000000);
      pos++;
    } else {
      break;
    }
  }
  return utf8_pos;
}

template <typename InputPtr>
#if SIMDUTF_CPLUSPLUS20
  requires simdutf::detail::indexes_into_byte_like<InputPtr>
#endif
simdutf_constexpr23 simdutf_warn_unused size_t
utf8_length_from_latin1(InputPtr input, size_t length) noexcept {
  size_t answer = length;
  size_t i = 0;

#if SIMDUTF_CPLUSPLUS23
  if !consteval
#endif
  {
    auto pop = [](uint64_t v) {
      return (size_t)(((v >> 7) & UINT64_C(0x0101010101010101)) *
                          UINT64_C(0x0101010101010101) >>
                      56);
    };
    for (; i + 32 <= length; i += 32) {
      uint64_t v;
      memcpy(&v, input + i, 8);
      answer += pop(v);
      memcpy(&v, input + i + 8, sizeof(v));
      answer += pop(v);
      memcpy(&v, input + i + 16, sizeof(v));
      answer += pop(v);
      memcpy(&v, input + i + 24, sizeof(v));
      answer += pop(v);
    }
    for (; i + 8 <= length; i += 8) {
      uint64_t v;
      memcpy(&v, input + i, sizeof(v));
      answer += pop(v);
    }
  } // !consteval scope
  for (; i + 1 <= length; i += 1) {
    answer += static_cast<uint8_t>(input[i]) >> 7;
  }
  return answer;
}

} // namespace latin1_to_utf8
} // unnamed namespace
} // namespace scalar
} // namespace simdutf

#endif
