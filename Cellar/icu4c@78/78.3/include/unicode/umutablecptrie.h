// © 2017 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

// umutablecptrie.h (split out of ucptrie.h)
// created: 2018jan24 Markus W. Scherer

#ifndef __UMUTABLECPTRIE_H__
#define __UMUTABLECPTRIE_H__

#include "unicode/utypes.h"

#include "unicode/ucpmap.h"
#include "unicode/ucptrie.h"
#include "unicode/utf8.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

U_CDECL_BEGIN

/**
 * \file
 * \brief C API: This file defines a mutable Unicode code point trie.
 *
 * @see UCPTrie
 * @see UMutableCPTrie
 */

/**
 * Mutable Unicode code point trie.
 * Fast map from Unicode code points (U+0000..U+10FFFF) to 32-bit integer values.
 * For details see https://icu.unicode.org/design/struct/utrie
 *
 * Setting values (especially ranges) and lookup is fast.
 * The mutable trie is only somewhat space-efficient.
 * It builds a compacted, immutable UCPTrie.
 *
 * This trie can be modified while iterating over its contents.
 * For example, it is possible to merge its values with those from another
 * set of ranges (e.g., another mutable or immutable trie):
 * Iterate over those source ranges; for each of them iterate over this trie;
 * add the source value into the value of each trie range.
 *
 * @see UCPTrie
 * @see umutablecptrie_buildImmutable
 * @stable ICU 63
 */
typedef struct UMutableCPTrie UMutableCPTrie;

/**
 * Creates a mutable trie that initially maps each Unicode code point to the same value.
 * It uses 32-bit data values until umutablecptrie_buildImmutable() is called.
 * umutablecptrie_buildImmutable() takes a valueWidth parameter which
 * determines the number of bits in the data value in the resulting UCPTrie.
 * You must umutablecptrie_close() the trie once you are done using it.
 *
 * @param initialValue the initial value that is set for all code points
 * @param errorValue the value for out-of-range code points and ill-formed UTF-8/16
 * @param pErrorCode an in/out ICU UErrorCode
 * @return the trie
 * @stable ICU 63
 */
U_CAPI UMutableCPTrie * U_EXPORT2
umutablecptrie_open(uint32_t initialValue, uint32_t errorValue, UErrorCode *pErrorCode);

/**
 * Clones a mutable trie.
 * You must umutablecptrie_close() the clone once you are done using it.
 *
 * @param other the trie to clone
 * @param pErrorCode an in/out ICU UErrorCode
 * @return the trie clone
 * @stable ICU 63
 */
U_CAPI UMutableCPTrie * U_EXPORT2
umutablecptrie_clone(const UMutableCPTrie *other, UErrorCode *pErrorCode);

/**
 * Closes a mutable trie and releases associated memory.
 *
 * @param trie the trie
 * @stable ICU 63
 */
U_CAPI void U_EXPORT2
umutablecptrie_close(UMutableCPTrie *trie);

/**
 * Creates a mutable trie with the same contents as the UCPMap.
 * You must umutablecptrie_close() the mutable trie once you are done using it.
 *
 * @param map the source map
 * @param pErrorCode an in/out ICU UErrorCode
 * @return the mutable trie
 * @stable ICU 63
 */
U_CAPI UMutableCPTrie * U_EXPORT2
umutablecptrie_fromUCPMap(const UCPMap *map, UErrorCode *pErrorCode);

/**
 * Creates a mutable trie with the same contents as the immutable one.
 * You must umutablecptrie_close() the mutable trie once you are done using it.
 *
 * @param trie the immutable trie
 * @param pErrorCode an in/out ICU UErrorCode
 * @return the mutable trie
 * @stable ICU 63
 */
U_CAPI UMutableCPTrie * U_EXPORT2
umutablecptrie_fromUCPTrie(const UCPTrie *trie, UErrorCode *pErrorCode);

/**
 * Returns the value for a code point as stored in the trie.
 *
 * @param trie the trie
 * @param c the code point
 * @return the value
 * @stable ICU 63
 */
U_CAPI uint32_t U_EXPORT2
umutablecptrie_get(const UMutableCPTrie *trie, UChar32 c);

/**
 * Returns the last code point such that all those from start to there have the same value.
 * Can be used to efficiently iterate over all same-value ranges in a trie.
 * (This is normally faster than iterating over code points and get()ting each value,
 * but much slower than a data structure that stores ranges directly.)
 *
 * The trie can be modified between calls to this function.
 *
 * If the UCPMapValueFilter function pointer is not NULL, then
 * the value to be delivered is passed through that function, and the return value is the end
 * of the range where all values are modified to the same actual value.
 * The value is unchanged if that function pointer is NULL.
 *
 * See the same-signature ucptrie_getRange() for a code sample.
 *
 * @param trie the trie
 * @param start range start
 * @param option defines whether surrogates are treated normally,
 *               or as having the surrogateValue; usually UCPMAP_RANGE_NORMAL
 * @param surrogateValue value for surrogates; ignored if option==UCPMAP_RANGE_NORMAL
 * @param filter a pointer to a function that may modify the trie data value,
 *     or NULL if the values from the trie are to be used unmodified
 * @param context an opaque pointer that is passed on to the filter function
 * @param pValue if not NULL, receives the value that every code point start..end has;
 *     may have been modified by filter(context, trie value)
 *     if that function pointer is not NULL
 * @return the range end code point, or -1 if start is not a valid code point
 * @stable ICU 63
 */
U_CAPI UChar32 U_EXPORT2
umutablecptrie_getRange(const UMutableCPTrie *trie, UChar32 start,
                        UCPMapRangeOption option, uint32_t surrogateValue,
                        UCPMapValueFilter *filter, const void *context, uint32_t *pValue);

/**
 * Sets a value for a code point.
 *
 * @param trie the trie
 * @param c the code point
 * @param value the value
 * @param pErrorCode an in/out ICU UErrorCode
 * @stable ICU 63
 */
U_CAPI void U_EXPORT2
umutablecptrie_set(UMutableCPTrie *trie, UChar32 c, uint32_t value, UErrorCode *pErrorCode);

/**
 * Sets a value for each code point [start..end].
 * Faster and more space-efficient than setting the value for each code point separately.
 *
 * @param trie the trie
 * @param start the first code point to get the value
 * @param end the last code point to get the value (inclusive)
 * @param value the value
 * @param pErrorCode an in/out ICU UErrorCode
 * @stable ICU 63
 */
U_CAPI void U_EXPORT2
umutablecptrie_setRange(UMutableCPTrie *trie,
                        UChar32 start, UChar32 end,
                        uint32_t value, UErrorCode *pErrorCode);

/**
 * Compacts the data and builds an immutable UCPTrie according to the parameters.
 * After this, the mutable trie will be empty.
 *
 * The mutable trie stores 32-bit values until buildImmutable() is called.
 * If values shorter than 32 bits are to be stored in the immutable trie,
 * then the upper bits are discarded.
 * For example, when the mutable trie contains values 0x81, -0x7f, and 0xa581,
 * and the value width is 8 bits, then each of these is stored as 0x81
 * and the immutable trie will return that as an unsigned value.
 * (Some implementations may want to make productive temporary use of the upper bits
 * until buildImmutable() discards them.)
 *
 * Not every possible set of mappings can be built into a UCPTrie,
 * because of limitations resulting from speed and space optimizations.
 * Every Unicode assigned character can be mapped to a unique value.
 * Typical data yields data structures far smaller than the limitations.
 *
 * It is possible to construct extremely unusual mappings that exceed the data structure limits.
 * In such a case this function will fail with a U_INDEX_OUTOFBOUNDS_ERROR.
 *
 * @param trie the trie trie
 * @param type selects the trie type
 * @param valueWidth selects the number of bits in a trie data value; if smaller than 32 bits,
 *                   then the values stored in the trie will be truncated first
 * @param pErrorCode an in/out ICU UErrorCode
 *
 * @see umutablecptrie_fromUCPTrie
 * @stable ICU 63
 */
U_CAPI UCPTrie * U_EXPORT2
umutablecptrie_buildImmutable(UMutableCPTrie *trie, UCPTrieType type, UCPTrieValueWidth valueWidth,
                              UErrorCode *pErrorCode);

U_CDECL_END

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUMutableCPTriePointer
 * "Smart pointer" class, closes a UMutableCPTrie via umutablecptrie_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 63
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUMutableCPTriePointer, UMutableCPTrie, umutablecptrie_close);

U_NAMESPACE_END

#endif

#endif
