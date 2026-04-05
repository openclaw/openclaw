// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 2002-2011 International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*   file name:  uiter.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2002jan18
*   created by: Markus W. Scherer
*/

#ifndef __UITER_H__
#define __UITER_H__

/**
 * \file
 * \brief C API: Unicode Character Iteration
 *
 * @see UCharIterator
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API
    U_NAMESPACE_BEGIN

    class CharacterIterator;
    class Replaceable;

    U_NAMESPACE_END
#endif

U_CDECL_BEGIN

struct UCharIterator;
typedef struct UCharIterator UCharIterator; /**< C typedef for struct UCharIterator. @stable ICU 2.1 */

/**
 * Origin constants for UCharIterator.getIndex() and UCharIterator.move().
 * @see UCharIteratorMove
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef enum UCharIteratorOrigin {
    UITER_START, UITER_CURRENT, UITER_LIMIT, UITER_ZERO, UITER_LENGTH
} UCharIteratorOrigin;

/** Constants for UCharIterator. @stable ICU 2.6 */
enum {
    /**
     * Constant value that may be returned by UCharIteratorMove
     * indicating that the final UTF-16 index is not known, but that the move succeeded.
     * This can occur when moving relative to limit or length, or
     * when moving relative to the current index after a setState()
     * when the current UTF-16 index is not known.
     *
     * It would be very inefficient to have to count from the beginning of the text
     * just to get the current/limit/length index after moving relative to it.
     * The actual index can be determined with getIndex(UITER_CURRENT)
     * which will count the UChars if necessary.
     *
     * @stable ICU 2.6
     */
    UITER_UNKNOWN_INDEX=-2
};


/**
 * Constant for UCharIterator getState() indicating an error or
 * an unknown state.
 * Returned by uiter_getState()/UCharIteratorGetState
 * when an error occurs.
 * Also, some UCharIterator implementations may not be able to return
 * a valid state for each position. This will be clearly documented
 * for each such iterator (none of the public ones here).
 *
 * @stable ICU 2.6
 */
#define UITER_NO_STATE ((uint32_t)0xffffffff)

/**
 * Function type declaration for UCharIterator.getIndex().
 *
 * Gets the current position, or the start or limit of the
 * iteration range.
 *
 * This function may perform slowly for UITER_CURRENT after setState() was called,
 * or for UITER_LENGTH, because an iterator implementation may have to count
 * UChars if the underlying storage is not UTF-16.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @param origin get the 0, start, limit, length, or current index
 * @return the requested index, or U_SENTINEL in an error condition
 *
 * @see UCharIteratorOrigin
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef int32_t U_CALLCONV
UCharIteratorGetIndex(UCharIterator *iter, UCharIteratorOrigin origin);

/**
 * Function type declaration for UCharIterator.move().
 *
 * Use iter->move(iter, index, UITER_ZERO) like CharacterIterator::setIndex(index).
 *
 * Moves the current position relative to the start or limit of the
 * iteration range, or relative to the current position itself.
 * The movement is expressed in numbers of code units forward
 * or backward by specifying a positive or negative delta.
 * Out of bounds movement will be pinned to the start or limit.
 *
 * This function may perform slowly for moving relative to UITER_LENGTH
 * because an iterator implementation may have to count the rest of the
 * UChars if the native storage is not UTF-16.
 *
 * When moving relative to the limit or length, or
 * relative to the current position after setState() was called,
 * move() may return UITER_UNKNOWN_INDEX (-2) to avoid an inefficient
 * determination of the actual UTF-16 index.
 * The actual index can be determined with getIndex(UITER_CURRENT)
 * which will count the UChars if necessary.
 * See UITER_UNKNOWN_INDEX for details.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @param delta can be positive, zero, or negative
 * @param origin move relative to the 0, start, limit, length, or current index
 * @return the new index, or U_SENTINEL on an error condition,
 *         or UITER_UNKNOWN_INDEX when the index is not known.
 *
 * @see UCharIteratorOrigin
 * @see UCharIterator
 * @see UITER_UNKNOWN_INDEX
 * @stable ICU 2.1
 */
typedef int32_t U_CALLCONV
UCharIteratorMove(UCharIterator *iter, int32_t delta, UCharIteratorOrigin origin);

/**
 * Function type declaration for UCharIterator.hasNext().
 *
 * Check if current() and next() can still
 * return another code unit.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return boolean value for whether current() and next() can still return another code unit
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef UBool U_CALLCONV
UCharIteratorHasNext(UCharIterator *iter);

/**
 * Function type declaration for UCharIterator.hasPrevious().
 *
 * Check if previous() can still return another code unit.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return boolean value for whether previous() can still return another code unit
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef UBool U_CALLCONV
UCharIteratorHasPrevious(UCharIterator *iter);
 
/**
 * Function type declaration for UCharIterator.current().
 *
 * Return the code unit at the current position,
 * or U_SENTINEL if there is none (index is at the limit).
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the current code unit
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef UChar32 U_CALLCONV
UCharIteratorCurrent(UCharIterator *iter);

/**
 * Function type declaration for UCharIterator.next().
 *
 * Return the code unit at the current index and increment
 * the index (post-increment, like s[i++]),
 * or return U_SENTINEL if there is none (index is at the limit).
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the current code unit (and post-increment the current index)
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef UChar32 U_CALLCONV
UCharIteratorNext(UCharIterator *iter);

/**
 * Function type declaration for UCharIterator.previous().
 *
 * Decrement the index and return the code unit from there
 * (pre-decrement, like s[--i]),
 * or return U_SENTINEL if there is none (index is at the start).
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the previous code unit (after pre-decrementing the current index)
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef UChar32 U_CALLCONV
UCharIteratorPrevious(UCharIterator *iter);

/**
 * Function type declaration for UCharIterator.reservedFn().
 * Reserved for future use.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @param something some integer argument
 * @return some integer
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
typedef int32_t U_CALLCONV
UCharIteratorReserved(UCharIterator *iter, int32_t something);

/**
 * Function type declaration for UCharIterator.getState().
 *
 * Get the "state" of the iterator in the form of a single 32-bit word.
 * It is recommended that the state value be calculated to be as small as
 * is feasible. For strings with limited lengths, fewer than 32 bits may
 * be sufficient.
 *
 * This is used together with setState()/UCharIteratorSetState
 * to save and restore the iterator position more efficiently than with
 * getIndex()/move().
 *
 * The iterator state is defined as a uint32_t value because it is designed
 * for use in ucol_nextSortKeyPart() which provides 32 bits to store the state
 * of the character iterator.
 *
 * With some UCharIterator implementations (e.g., UTF-8),
 * getting and setting the UTF-16 index with existing functions
 * (getIndex(UITER_CURRENT) followed by move(pos, UITER_ZERO)) is possible but
 * relatively slow because the iterator has to "walk" from a known index
 * to the requested one.
 * This takes more time the farther it needs to go.
 *
 * An opaque state value allows an iterator implementation to provide
 * an internal index (UTF-8: the source byte array index) for
 * fast, constant-time restoration.
 *
 * After calling setState(), a getIndex(UITER_CURRENT) may be slow because
 * the UTF-16 index may not be restored as well, but the iterator can deliver
 * the correct text contents and move relative to the current position
 * without performance degradation.
 *
 * Some UCharIterator implementations may not be able to return
 * a valid state for each position, in which case they return UITER_NO_STATE instead.
 * This will be clearly documented for each such iterator (none of the public ones here).
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the state word
 *
 * @see UCharIterator
 * @see UCharIteratorSetState
 * @see UITER_NO_STATE
 * @stable ICU 2.6
 */
typedef uint32_t U_CALLCONV
UCharIteratorGetState(const UCharIterator *iter);

/**
 * Function type declaration for UCharIterator.setState().
 *
 * Restore the "state" of the iterator using a state word from a getState() call.
 * The iterator object need not be the same one as for which getState() was called,
 * but it must be of the same type (set up using the same uiter_setXYZ function)
 * and it must iterate over the same string
 * (binary identical regardless of memory address).
 * For more about the state word see UCharIteratorGetState.
 *
 * After calling setState(), a getIndex(UITER_CURRENT) may be slow because
 * the UTF-16 index may not be restored as well, but the iterator can deliver
 * the correct text contents and move relative to the current position
 * without performance degradation.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @param state the state word from a getState() call
 *              on a same-type, same-string iterator
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                   which must not indicate a failure before the function call.
 *
 * @see UCharIterator
 * @see UCharIteratorGetState
 * @stable ICU 2.6
 */
typedef void U_CALLCONV
UCharIteratorSetState(UCharIterator *iter, uint32_t state, UErrorCode *pErrorCode);


/**
 * C API for code unit iteration.
 * This can be used as a C wrapper around
 * CharacterIterator, Replaceable, or implemented using simple strings, etc.
 *
 * There are two roles for using UCharIterator:
 *
 * A "provider" sets the necessary function pointers and controls the "protected"
 * fields of the UCharIterator structure. A "provider" passes a UCharIterator
 * into C APIs that need a UCharIterator as an abstract, flexible string interface.
 *
 * Implementations of such C APIs are "callers" of UCharIterator functions;
 * they only use the "public" function pointers and never access the "protected"
 * fields directly.
 *
 * The current() and next() functions only check the current index against the
 * limit, and previous() only checks the current index against the start,
 * to see if the iterator already reached the end of the iteration range.
 *
 * The assumption - in all iterators - is that the index is moved via the API,
 * which means it won't go out of bounds, or the index is modified by
 * user code that knows enough about the iterator implementation to set valid
 * index values.
 *
 * UCharIterator functions return code unit values 0..0xffff,
 * or U_SENTINEL if the iteration bounds are reached.
 *
 * @stable ICU 2.1
 */
struct UCharIterator {
    /**
     * (protected) Pointer to string or wrapped object or similar.
     * Not used by caller.
     * @stable ICU 2.1
     */
    const void *context;

    /**
     * (protected) Length of string or similar.
     * Not used by caller.
     * @stable ICU 2.1
     */
    int32_t length;

    /**
     * (protected) Start index or similar.
     * Not used by caller.
     * @stable ICU 2.1
     */
    int32_t start;

    /**
     * (protected) Current index or similar.
     * Not used by caller.
     * @stable ICU 2.1
     */
    int32_t index;

    /**
     * (protected) Limit index or similar.
     * Not used by caller.
     * @stable ICU 2.1
     */
    int32_t limit;

    /**
     * (protected) Used by UTF-8 iterators and possibly others.
     * @stable ICU 2.1
     */
    int32_t reservedField;

    /**
     * (public) Returns the current position or the
     * start or limit index of the iteration range.
     *
     * @see UCharIteratorGetIndex
     * @stable ICU 2.1
     */
    UCharIteratorGetIndex *getIndex;

    /**
     * (public) Moves the current position relative to the start or limit of the
     * iteration range, or relative to the current position itself.
     * The movement is expressed in numbers of code units forward
     * or backward by specifying a positive or negative delta.
     *
     * @see UCharIteratorMove
     * @stable ICU 2.1
     */
    UCharIteratorMove *move;

    /**
     * (public) Check if current() and next() can still
     * return another code unit.
     *
     * @see UCharIteratorHasNext
     * @stable ICU 2.1
     */
    UCharIteratorHasNext *hasNext;

    /**
     * (public) Check if previous() can still return another code unit.
     *
     * @see UCharIteratorHasPrevious
     * @stable ICU 2.1
     */
    UCharIteratorHasPrevious *hasPrevious;

    /**
     * (public) Return the code unit at the current position,
     * or U_SENTINEL if there is none (index is at the limit).
     *
     * @see UCharIteratorCurrent
     * @stable ICU 2.1
     */
    UCharIteratorCurrent *current;

    /**
     * (public) Return the code unit at the current index and increment
     * the index (post-increment, like s[i++]),
     * or return U_SENTINEL if there is none (index is at the limit).
     *
     * @see UCharIteratorNext
     * @stable ICU 2.1
     */
    UCharIteratorNext *next;

    /**
     * (public) Decrement the index and return the code unit from there
     * (pre-decrement, like s[--i]),
     * or return U_SENTINEL if there is none (index is at the start).
     *
     * @see UCharIteratorPrevious
     * @stable ICU 2.1
     */
    UCharIteratorPrevious *previous;

    /**
     * (public) Reserved for future use. Currently NULL.
     *
     * @see UCharIteratorReserved
     * @stable ICU 2.1
     */
    UCharIteratorReserved *reservedFn;

    /**
     * (public) Return the state of the iterator, to be restored later with setState().
     * This function pointer is NULL if the iterator does not implement it.
     *
     * @see UCharIteratorGet
     * @stable ICU 2.6
     */
    UCharIteratorGetState *getState;

    /**
     * (public) Restore the iterator state from the state word from a call
     * to getState().
     * This function pointer is NULL if the iterator does not implement it.
     *
     * @see UCharIteratorSet
     * @stable ICU 2.6
     */
    UCharIteratorSetState *setState;
};

/**
 * Helper function for UCharIterator to get the code point
 * at the current index.
 *
 * Return the code point that includes the code unit at the current position,
 * or U_SENTINEL if there is none (index is at the limit).
 * If the current code unit is a lead or trail surrogate,
 * then the following or preceding surrogate is used to form
 * the code point value.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the current code point
 *
 * @see UCharIterator
 * @see U16_GET
 * @see UnicodeString::char32At()
 * @stable ICU 2.1
 */
U_CAPI UChar32 U_EXPORT2
uiter_current32(UCharIterator *iter);

/**
 * Helper function for UCharIterator to get the next code point.
 *
 * Return the code point at the current index and increment
 * the index (post-increment, like s[i++]),
 * or return U_SENTINEL if there is none (index is at the limit).
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the current code point (and post-increment the current index)
 *
 * @see UCharIterator
 * @see U16_NEXT
 * @stable ICU 2.1
 */
U_CAPI UChar32 U_EXPORT2
uiter_next32(UCharIterator *iter);

/**
 * Helper function for UCharIterator to get the previous code point.
 *
 * Decrement the index and return the code point from there
 * (pre-decrement, like s[--i]),
 * or return U_SENTINEL if there is none (index is at the start).
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the previous code point (after pre-decrementing the current index)
 *
 * @see UCharIterator
 * @see U16_PREV
 * @stable ICU 2.1
 */
U_CAPI UChar32 U_EXPORT2
uiter_previous32(UCharIterator *iter);

/**
 * Get the "state" of the iterator in the form of a single 32-bit word.
 * This is a convenience function that calls iter->getState(iter)
 * if iter->getState is not NULL;
 * if it is NULL or any other error occurs, then UITER_NO_STATE is returned.
 *
 * Some UCharIterator implementations may not be able to return
 * a valid state for each position, in which case they return UITER_NO_STATE instead.
 * This will be clearly documented for each such iterator (none of the public ones here).
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @return the state word
 *
 * @see UCharIterator
 * @see UCharIteratorGetState
 * @see UITER_NO_STATE
 * @stable ICU 2.6
 */
U_CAPI uint32_t U_EXPORT2
uiter_getState(const UCharIterator *iter);

/**
 * Restore the "state" of the iterator using a state word from a getState() call.
 * This is a convenience function that calls iter->setState(iter, state, pErrorCode)
 * if iter->setState is not NULL; if it is NULL, then U_UNSUPPORTED_ERROR is set.
 *
 * @param iter the UCharIterator structure ("this pointer")
 * @param state the state word from a getState() call
 *              on a same-type, same-string iterator
 * @param pErrorCode Must be a valid pointer to an error code value,
 *                   which must not indicate a failure before the function call.
 *
 * @see UCharIterator
 * @see UCharIteratorSetState
 * @stable ICU 2.6
 */
U_CAPI void U_EXPORT2
uiter_setState(UCharIterator *iter, uint32_t state, UErrorCode *pErrorCode);

/**
 * Set up a UCharIterator to iterate over a string.
 *
 * Sets the UCharIterator function pointers for iteration over the string s
 * with iteration boundaries start=index=0 and length=limit=string length.
 * The "provider" may set the start, index, and limit values at any time
 * within the range 0..length.
 * The length field will be ignored.
 *
 * The string pointer s is set into UCharIterator.context without copying
 * or reallocating the string contents.
 *
 * getState() simply returns the current index.
 * move() will always return the final index.
 *
 * @param iter UCharIterator structure to be set for iteration
 * @param s String to iterate over
 * @param length Length of s, or -1 if NUL-terminated
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
U_CAPI void U_EXPORT2
uiter_setString(UCharIterator *iter, const UChar *s, int32_t length);

/**
 * Set up a UCharIterator to iterate over a UTF-16BE string
 * (byte vector with a big-endian pair of bytes per UChar).
 *
 * Everything works just like with a normal UChar iterator (uiter_setString),
 * except that UChars are assembled from byte pairs,
 * and that the length argument here indicates an even number of bytes.
 *
 * getState() simply returns the current index.
 * move() will always return the final index.
 *
 * @param iter UCharIterator structure to be set for iteration
 * @param s UTF-16BE string to iterate over
 * @param length Length of s as an even number of bytes, or -1 if NUL-terminated
 *               (NUL means pair of 0 bytes at even index from s)
 *
 * @see UCharIterator
 * @see uiter_setString
 * @stable ICU 2.6
 */
U_CAPI void U_EXPORT2
uiter_setUTF16BE(UCharIterator *iter, const char *s, int32_t length);

/**
 * Set up a UCharIterator to iterate over a UTF-8 string.
 *
 * Sets the UCharIterator function pointers for iteration over the UTF-8 string s
 * with UTF-8 iteration boundaries 0 and length.
 * The implementation counts the UTF-16 index on the fly and
 * lazily evaluates the UTF-16 length of the text.
 *
 * The start field is used as the UTF-8 offset, the limit field as the UTF-8 length.
 * When the reservedField is not 0, then it contains a supplementary code point
 * and the UTF-16 index is between the two corresponding surrogates.
 * At that point, the UTF-8 index is behind that code point.
 *
 * The UTF-8 string pointer s is set into UCharIterator.context without copying
 * or reallocating the string contents.
 *
 * getState() returns a state value consisting of
 * - the current UTF-8 source byte index (bits 31..1)
 * - a flag (bit 0) that indicates whether the UChar position is in the middle
 *   of a surrogate pair
 *   (from a 4-byte UTF-8 sequence for the corresponding supplementary code point)
 *
 * getState() cannot also encode the UTF-16 index in the state value.
 * move(relative to limit or length), or
 * move(relative to current) after setState(), may return UITER_UNKNOWN_INDEX.
 *
 * @param iter UCharIterator structure to be set for iteration
 * @param s UTF-8 string to iterate over
 * @param length Length of s in bytes, or -1 if NUL-terminated
 *
 * @see UCharIterator
 * @stable ICU 2.6
 */
U_CAPI void U_EXPORT2
uiter_setUTF8(UCharIterator *iter, const char *s, int32_t length);

#if U_SHOW_CPLUSPLUS_API

/**
 * Set up a UCharIterator to wrap around a C++ CharacterIterator.
 *
 * Sets the UCharIterator function pointers for iteration using the
 * CharacterIterator charIter.
 *
 * The CharacterIterator pointer charIter is set into UCharIterator.context
 * without copying or cloning the CharacterIterator object.
 * The other "protected" UCharIterator fields are set to 0 and will be ignored.
 * The iteration index and boundaries are controlled by the CharacterIterator.
 *
 * getState() simply returns the current index.
 * move() will always return the final index.
 *
 * @param iter UCharIterator structure to be set for iteration
 * @param charIter CharacterIterator to wrap
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
U_CAPI void U_EXPORT2
uiter_setCharacterIterator(UCharIterator *iter, icu::CharacterIterator *charIter);

/**
 * Set up a UCharIterator to iterate over a C++ Replaceable.
 *
 * Sets the UCharIterator function pointers for iteration over the
 * Replaceable rep with iteration boundaries start=index=0 and
 * length=limit=rep->length().
 * The "provider" may set the start, index, and limit values at any time
 * within the range 0..length=rep->length().
 * The length field will be ignored.
 *
 * The Replaceable pointer rep is set into UCharIterator.context without copying
 * or cloning/reallocating the Replaceable object.
 *
 * getState() simply returns the current index.
 * move() will always return the final index.
 *
 * @param iter UCharIterator structure to be set for iteration
 * @param rep Replaceable to iterate over
 *
 * @see UCharIterator
 * @stable ICU 2.1
 */
U_CAPI void U_EXPORT2
uiter_setReplaceable(UCharIterator *iter, const icu::Replaceable *rep);

#endif

U_CDECL_END

#endif
