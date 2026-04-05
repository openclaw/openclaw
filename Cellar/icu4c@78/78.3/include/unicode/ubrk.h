// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
* Copyright (C) 1996-2015, International Business Machines Corporation and others.
* All Rights Reserved.
******************************************************************************
*/

#ifndef UBRK_H
#define UBRK_H

#include "unicode/utypes.h"
#include "unicode/uloc.h"
#include "unicode/utext.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * A text-break iterator.
 *  For usage in C programs.
 */
#ifndef UBRK_TYPEDEF_UBREAK_ITERATOR
#   define UBRK_TYPEDEF_UBREAK_ITERATOR
    /**
     *  Opaque type representing an ICU Break iterator object.
     *  @stable ICU 2.0
     */
    typedef struct UBreakIterator UBreakIterator;
#endif

#if !UCONFIG_NO_BREAK_ITERATION

#include "unicode/parseerr.h"

/**
 * \file
 * \brief C API: BreakIterator
 *
 * <h2> BreakIterator C API </h2>
 *
 * The BreakIterator C API defines  methods for finding the location
 * of boundaries in text. Pointer to a UBreakIterator maintain a
 * current position and scan over text returning the index of characters
 * where boundaries occur.
 * <p>
 * Line boundary analysis determines where a text string can be broken
 * when line-wrapping. The mechanism correctly handles punctuation and
 * hyphenated words.
 * <p>
 * Note: The locale keyword "lb" can be used to modify line break
 * behavior according to the CSS level 3 line-break options, see
 * <http://dev.w3.org/csswg/css-text/#line-breaking>. For example:
 * "ja@lb=strict", "zh@lb=loose".
 * <p>
 * Sentence boundary analysis allows selection with correct
 * interpretation of periods within numbers and abbreviations, and
 * trailing punctuation marks such as quotation marks and parentheses.
 * <p>
 * Note: The locale keyword "ss" can be used to enable use of
 * segmentation suppression data (preventing breaks in English after
 * abbreviations such as "Mr." or "Est.", for example), as follows:
 * "en@ss=standard".
 * <p>
 * Word boundary analysis is used by search and replace functions, as
 * well as within text editing applications that allow the user to
 * select words with a double click. Word selection provides correct
 * interpretation of punctuation marks within and following
 * words. Characters that are not part of a word, such as symbols or
 * punctuation marks, have word-breaks on both sides.
 * <p>
 * Character boundary analysis identifies the boundaries of
 * "Extended Grapheme Clusters", which are groupings of codepoints
 * that should be treated as character-like units for many text operations.
 * Please see Unicode Standard Annex #29, Unicode Text Segmentation,
 * http://www.unicode.org/reports/tr29/ for additional information
 * on grapheme clusters and guidelines on their use.
 * <p>
 * Title boundary analysis locates all positions,
 * typically starts of words, that should be set to Title Case
 * when title casing the text.
 * <p>
 * The text boundary positions are found according to the rules
 * described in Unicode Standard Annex #29, Text Boundaries, and
 * Unicode Standard Annex #14, Line Breaking Properties.  These
 * are available at http://www.unicode.org/reports/tr14/ and
 * http://www.unicode.org/reports/tr29/.
 * <p>
 * In addition to the plain C API defined in this header file, an
 * object oriented C++ API with equivalent functionality is defined in the
 * file brkiter.h.
 * <p>
 * Code snippets illustrating the use of the Break Iterator APIs
 * are available in the ICU User Guide,
 * https://unicode-org.github.io/icu/userguide/boundaryanalysis/
 * and in the sample program icu/source/samples/break/break.cpp
 */

/** The possible types of text boundaries.  @stable ICU 2.0 */
typedef enum UBreakIteratorType {
  /** Character breaks  @stable ICU 2.0 */
  UBRK_CHARACTER = 0,
  /** Word breaks @stable ICU 2.0 */
  UBRK_WORD = 1,
  /** Line breaks @stable ICU 2.0 */
  UBRK_LINE = 2,
  /** Sentence breaks @stable ICU 2.0 */
  UBRK_SENTENCE = 3,

#ifndef U_HIDE_DEPRECATED_API
  /**
   * Title Case breaks
   * The iterator created using this type locates title boundaries as described for
   * Unicode 3.2 only. For Unicode 4.0 and above title boundary iteration,
   * please use Word Boundary iterator.
   *
   * @deprecated ICU 2.8 Use the word break iterator for titlecasing for Unicode 4 and later.
   */
  UBRK_TITLE = 4,
    /**
     * One more than the highest normal UBreakIteratorType value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UBRK_COUNT = 5
#endif  // U_HIDE_DEPRECATED_API
} UBreakIteratorType;

/** Value indicating all text boundaries have been returned.
 *  @stable ICU 2.0
 */
#define UBRK_DONE ((int32_t) -1)


/**
 *  Enum constants for the word break tags returned by
 *  getRuleStatus().  A range of values is defined for each category of
 *  word, to allow for further subdivisions of a category in future releases.
 *  Applications should check for tag values falling within the range, rather
 *  than for single individual values.
 *
 * The numeric values of all of these constants are stable (will not change).
 *
 * @stable ICU 2.2
*/
typedef enum UWordBreak {
    /** Tag value for "words" that do not fit into any of other categories.
     *  Includes spaces and most punctuation. */
    UBRK_WORD_NONE           = 0,
    /** Upper bound for tags for uncategorized words. */
    UBRK_WORD_NONE_LIMIT     = 100,
    /** Tag value for words that appear to be numbers, lower limit.    */
    UBRK_WORD_NUMBER         = 100,
    /** Tag value for words that appear to be numbers, upper limit.    */
    UBRK_WORD_NUMBER_LIMIT   = 200,
    /** Tag value for words that contain letters, excluding
     *  hiragana, katakana or ideographic characters, lower limit.    */
    UBRK_WORD_LETTER         = 200,
    /** Tag value for words containing letters, upper limit  */
    UBRK_WORD_LETTER_LIMIT   = 300,
    /** Tag value for words containing kana characters, lower limit */
    UBRK_WORD_KANA           = 300,
    /** Tag value for words containing kana characters, upper limit */
    UBRK_WORD_KANA_LIMIT     = 400,
    /** Tag value for words containing ideographic characters, lower limit */
    UBRK_WORD_IDEO           = 400,
    /** Tag value for words containing ideographic characters, upper limit */
    UBRK_WORD_IDEO_LIMIT     = 500
} UWordBreak;

/**
 *  Enum constants for the line break tags returned by getRuleStatus().
 *  A range of values is defined for each category of
 *  word, to allow for further subdivisions of a category in future releases.
 *  Applications should check for tag values falling within the range, rather
 *  than for single individual values.
 *
 * The numeric values of all of these constants are stable (will not change).
 *
 * @stable ICU 2.8
*/
typedef enum ULineBreakTag {
    /** Tag value for soft line breaks, positions at which a line break
      *  is acceptable but not required                */
    UBRK_LINE_SOFT            = 0,
    /** Upper bound for soft line breaks.              */
    UBRK_LINE_SOFT_LIMIT      = 100,
    /** Tag value for a hard, or mandatory line break  */
    UBRK_LINE_HARD            = 100,
    /** Upper bound for hard line breaks.              */
    UBRK_LINE_HARD_LIMIT      = 200
} ULineBreakTag;



/**
 *  Enum constants for the sentence break tags returned by getRuleStatus().
 *  A range of values is defined for each category of
 *  sentence, to allow for further subdivisions of a category in future releases.
 *  Applications should check for tag values falling within the range, rather
 *  than for single individual values.
 *
 * The numeric values of all of these constants are stable (will not change).
 *
 * @stable ICU 2.8
*/
typedef enum USentenceBreakTag {
    /** Tag value for for sentences  ending with a sentence terminator
      * ('.', '?', '!', etc.) character, possibly followed by a
      * hard separator (CR, LF, PS, etc.)
      */
    UBRK_SENTENCE_TERM       = 0,
    /** Upper bound for tags for sentences ended by sentence terminators.    */
    UBRK_SENTENCE_TERM_LIMIT = 100,
    /** Tag value for for sentences that do not contain an ending
      * sentence terminator ('.', '?', '!', etc.) character, but
      * are ended only by a hard separator (CR, LF, PS, etc.) or end of input.
      */
    UBRK_SENTENCE_SEP        = 100,
    /** Upper bound for tags for sentences ended by a separator.              */
    UBRK_SENTENCE_SEP_LIMIT  = 200
    /** Tag value for a hard, or mandatory line break  */
} USentenceBreakTag;


/**
 * Open a new UBreakIterator for locating text boundaries for a specified locale.
 * A UBreakIterator may be used for detecting character, line, word,
 * and sentence breaks in text.
 * @param type The type of UBreakIterator to open: one of UBRK_CHARACTER, UBRK_WORD,
 * UBRK_LINE, UBRK_SENTENCE
 * @param locale The locale specifying the text-breaking conventions. Note that
 * locale keys such as "lb" and "ss" may be used to modify text break behavior,
 * see general discussion of BreakIterator C API.
 * @param text The text to be iterated over. May be null, in which case ubrk_setText() is
 *        used to specify the text to be iterated.
 * @param textLength The number of characters in text, or -1 if null-terminated.
 * @param status A UErrorCode to receive any errors.
 * @return A UBreakIterator for the specified locale.
 * @see ubrk_openRules
 * @stable ICU 2.0
 */
U_CAPI UBreakIterator* U_EXPORT2
ubrk_open(UBreakIteratorType type,
      const char *locale,
      const UChar *text,
      int32_t textLength,
      UErrorCode *status);

/**
 * Open a new UBreakIterator for locating text boundaries using specified breaking rules.
 * The rule syntax is ... (TBD)
 * @param rules A set of rules specifying the text breaking conventions.
 * @param rulesLength The number of characters in rules, or -1 if null-terminated.
 * @param text The text to be iterated over.  May be null, in which case ubrk_setText() is
 *        used to specify the text to be iterated.
 * @param textLength The number of characters in text, or -1 if null-terminated.
 * @param parseErr   Receives position and context information for any syntax errors
 *                   detected while parsing the rules.
 * @param status A UErrorCode to receive any errors.
 * @return A UBreakIterator for the specified rules.
 * @see ubrk_open
 * @stable ICU 2.2
 */
U_CAPI UBreakIterator* U_EXPORT2
ubrk_openRules(const UChar     *rules,
               int32_t         rulesLength,
               const UChar     *text,
               int32_t          textLength,
               UParseError     *parseErr,
               UErrorCode      *status);

/**
 * Open a new UBreakIterator for locating text boundaries using precompiled binary rules.
 * Opening a UBreakIterator this way is substantially faster than using ubrk_openRules.
 * Binary rules may be obtained using ubrk_getBinaryRules. The compiled rules are not
 * compatible across different major versions of ICU, nor across platforms of different
 * endianness or different base character set family (ASCII vs EBCDIC).
 * @param binaryRules A set of compiled binary rules specifying the text breaking
 *                    conventions. Ownership of the storage containing the compiled
 *                    rules remains with the caller of this function. The compiled
 *                    rules must not be modified or deleted during the life of the
 *                    break iterator.
 * @param rulesLength The length of binaryRules in bytes; must be >= 0.
 * @param text        The text to be iterated over.  May be null, in which case
 *                    ubrk_setText() is used to specify the text to be iterated.
 * @param textLength  The number of characters in text, or -1 if null-terminated.
 * @param status      Pointer to UErrorCode to receive any errors.
 * @return            UBreakIterator for the specified rules.
 * @see ubrk_getBinaryRules
 * @stable ICU 59
 */
U_CAPI UBreakIterator* U_EXPORT2
ubrk_openBinaryRules(const uint8_t *binaryRules, int32_t rulesLength,
                     const UChar *  text, int32_t textLength,
                     UErrorCode *   status);

#ifndef U_HIDE_DEPRECATED_API

/**
 * Thread safe cloning operation
 * @param bi iterator to be cloned
 * @param stackBuffer <em>Deprecated functionality as of ICU 52, use NULL.</em><br>
 *  user allocated space for the new clone. If NULL new memory will be allocated.
 *  If buffer is not large enough, new memory will be allocated.
 *  Clients can use the U_BRK_SAFECLONE_BUFFERSIZE.
 * @param pBufferSize <em>Deprecated functionality as of ICU 52, use NULL or 1.</em><br>
 *  pointer to size of allocated space.
 *  If *pBufferSize == 0, a sufficient size for use in cloning will
 *  be returned ('pre-flighting')
 *  If *pBufferSize is not enough for a stack-based safe clone,
 *  new memory will be allocated.
 * @param status to indicate whether the operation went on smoothly or there were errors
 *  An informational status value, U_SAFECLONE_ALLOCATED_ERROR, is used
 * if pBufferSize != NULL and any allocations were necessary
 * @return pointer to the new clone
 * @deprecated ICU 69 Use ubrk_clone() instead.
 */
U_DEPRECATED UBreakIterator * U_EXPORT2
ubrk_safeClone(
          const UBreakIterator *bi,
          void *stackBuffer,
          int32_t *pBufferSize,
          UErrorCode *status);

#endif /* U_HIDE_DEPRECATED_API */

/**
 * Thread safe cloning operation.
 * @param bi iterator to be cloned
 * @param status to indicate whether the operation went on smoothly or there were errors
 * @return pointer to the new clone
 * @stable ICU 69
 */
U_CAPI UBreakIterator * U_EXPORT2
ubrk_clone(const UBreakIterator *bi,
           UErrorCode *status);

#ifndef U_HIDE_DEPRECATED_API

/**
  * A recommended size (in bytes) for the memory buffer to be passed to ubrk_saveClone().
  * @deprecated ICU 52. Do not rely on ubrk_safeClone() cloning into any provided buffer.
  */
#define U_BRK_SAFECLONE_BUFFERSIZE 1

#endif /* U_HIDE_DEPRECATED_API */

/**
* Close a UBreakIterator.
* Once closed, a UBreakIterator may no longer be used.
* @param bi The break iterator to close.
 * @stable ICU 2.0
*/
U_CAPI void U_EXPORT2
ubrk_close(UBreakIterator *bi);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUBreakIteratorPointer
 * "Smart pointer" class, closes a UBreakIterator via ubrk_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUBreakIteratorPointer, UBreakIterator, ubrk_close);

U_NAMESPACE_END

#endif

/**
 * Sets an existing iterator to point to a new piece of text.
 * The break iterator retains a pointer to the supplied text.
 * The caller must not modify or delete the text while the BreakIterator
 * retains the reference.
 *
 * @param bi The iterator to use
 * @param text The text to be set
 * @param textLength The length of the text
 * @param status The error code
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubrk_setText(UBreakIterator* bi,
             const UChar*    text,
             int32_t         textLength,
             UErrorCode*     status);


/**
 * Sets an existing iterator to point to a new piece of text.
 *
 * All index positions returned by break iterator functions are
 * native indices from the UText. For example, when breaking UTF-8
 * encoded text, the break positions returned by \ref ubrk_next, \ref ubrk_previous, etc.
 * will be UTF-8 string indices, not UTF-16 positions.
 *
 * @param bi The iterator to use
 * @param text The text to be set.
 *             This function makes a shallow clone of the supplied UText.  This means
 *             that the caller is free to immediately close or otherwise reuse the
 *             UText that was passed as a parameter, but that the underlying text itself
 *             must not be altered while being referenced by the break iterator.
 * @param status The error code
 * @stable ICU 3.4
 */
U_CAPI void U_EXPORT2
ubrk_setUText(UBreakIterator* bi,
             UText*          text,
             UErrorCode*     status);



/**
 * Determine the most recently-returned text boundary.
 *
 * @param bi The break iterator to use.
 * @return The character index most recently returned by \ref ubrk_next, \ref ubrk_previous,
 * \ref ubrk_first, or \ref ubrk_last.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubrk_current(const UBreakIterator *bi);

/**
 * Advance the iterator to the boundary following the current boundary.
 *
 * @param bi The break iterator to use.
 * @return The character index of the next text boundary, or UBRK_DONE
 * if all text boundaries have been returned.
 * @see ubrk_previous
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubrk_next(UBreakIterator *bi);

/**
 * Set the iterator position to the boundary preceding the current boundary.
 *
 * @param bi The break iterator to use.
 * @return The character index of the preceding text boundary, or UBRK_DONE
 * if all text boundaries have been returned.
 * @see ubrk_next
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubrk_previous(UBreakIterator *bi);

/**
 * Set the iterator position to zero, the start of the text being scanned.
 * @param bi The break iterator to use.
 * @return The new iterator position (zero).
 * @see ubrk_last
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubrk_first(UBreakIterator *bi);

/**
 * Set the iterator position to the index immediately <EM>beyond</EM> the last character in the text being scanned.
 * This is not the same as the last character.
 * @param bi The break iterator to use.
 * @return The character offset immediately <EM>beyond</EM> the last character in the
 * text being scanned.
 * @see ubrk_first
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubrk_last(UBreakIterator *bi);

/**
 * Set the iterator position to the first boundary preceding the specified offset.
 * The new position is always smaller than offset, or UBRK_DONE.
 * @param bi The break iterator to use.
 * @param offset The offset to begin scanning.
 * @return The text boundary preceding offset, or UBRK_DONE.
 * @see ubrk_following
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubrk_preceding(UBreakIterator *bi,
           int32_t offset);

/**
 * Advance the iterator to the first boundary following the specified offset.
 * The value returned is always greater than offset, or UBRK_DONE.
 * @param bi The break iterator to use.
 * @param offset The offset to begin scanning.
 * @return The text boundary following offset, or UBRK_DONE.
 * @see ubrk_preceding
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubrk_following(UBreakIterator *bi,
           int32_t offset);

/**
* Get a locale for which text breaking information is available.
* A UBreakIterator in a locale returned by this function will perform the correct
* text breaking for the locale.
* @param index The index of the desired locale.
* @return A locale for which number text breaking information is available, or 0 if none.
* @see ubrk_countAvailable
* @stable ICU 2.0
*/
U_CAPI const char* U_EXPORT2
ubrk_getAvailable(int32_t index);

/**
* Determine how many locales have text breaking information available.
* This function is most useful as determining the loop ending condition for
* calls to \ref ubrk_getAvailable.
* @return The number of locales for which text breaking information is available.
* @see ubrk_getAvailable
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2
ubrk_countAvailable(void);


/**
* Returns true if the specified position is a boundary position.  As a side
* effect, leaves the iterator pointing to the first boundary position at
* or after "offset".
* @param bi The break iterator to use.
* @param offset the offset to check.
* @return True if "offset" is a boundary position.
* @stable ICU 2.0
*/
U_CAPI  UBool U_EXPORT2
ubrk_isBoundary(UBreakIterator *bi, int32_t offset);

/**
 * Return the status from the break rule that determined the most recently
 * returned break position.  The values appear in the rule source
 * within brackets, {123}, for example.  For rules that do not specify a
 * status, a default value of 0 is returned.
 * <p>
 * For word break iterators, the possible values are defined in enum UWordBreak.
 * @stable ICU 2.2
 */
U_CAPI  int32_t U_EXPORT2
ubrk_getRuleStatus(UBreakIterator *bi);

/**
 * Get the statuses from the break rules that determined the most recently
 * returned break position.  The values appear in the rule source
 * within brackets, {123}, for example.  The default status value for rules
 * that do not explicitly provide one is zero.
 * <p>
 * For word break iterators, the possible values are defined in enum UWordBreak.
 * @param bi        The break iterator to use
 * @param fillInVec an array to be filled in with the status values.
 * @param capacity  the length of the supplied vector.  A length of zero causes
 *                  the function to return the number of status values, in the
 *                  normal way, without attempting to store any values.
 * @param status    receives error codes.
 * @return          The number of rule status values from rules that determined
 *                  the most recent boundary returned by the break iterator.
 * @stable ICU 3.0
 */
U_CAPI  int32_t U_EXPORT2
ubrk_getRuleStatusVec(UBreakIterator *bi, int32_t *fillInVec, int32_t capacity, UErrorCode *status);

/**
 * Return the locale of the break iterator. You can choose between the valid and
 * the actual locale.
 * @param bi break iterator
 * @param type locale type (valid or actual)
 * @param status error code
 * @return locale string
 * @stable ICU 2.8
 */
U_CAPI const char* U_EXPORT2
ubrk_getLocaleByType(const UBreakIterator *bi, ULocDataLocaleType type, UErrorCode* status);

/**
  *  Set the subject text string upon which the break iterator is operating
  *  without changing any other aspect of the state.
  *  The new and previous text strings must have the same content.
  *
  *  This function is intended for use in environments where ICU is operating on
  *  strings that may move around in memory.  It provides a mechanism for notifying
  *  ICU that the string has been relocated, and providing a new UText to access the
  *  string in its new position.
  *
  *  Note that the break iterator never copies the underlying text
  *  of a string being processed, but always operates directly on the original text
  *  provided by the user. Refreshing simply drops the references to the old text
  *  and replaces them with references to the new.
  *
  *  Caution:  this function is normally used only by very specialized
  *            system-level code.   One example use case is with garbage collection
  *            that moves the text in memory.
  *
  * @param bi         The break iterator.
  * @param text       The new (moved) text string.
  * @param status     Receives errors detected by this function.
  *
  * @stable ICU 49
  */
U_CAPI void U_EXPORT2
ubrk_refreshUText(UBreakIterator *bi,
                       UText          *text,
                       UErrorCode     *status);


/**
 * Get a compiled binary version of the rules specifying the behavior of a UBreakIterator.
 * The binary rules may be used with ubrk_openBinaryRules to open a new UBreakIterator
 * more quickly than using ubrk_openRules. The compiled rules are not compatible across
 * different major versions of ICU, nor across platforms of different endianness or
 * different base character set family (ASCII vs EBCDIC). Supports preflighting (with
 * binaryRules=NULL and rulesCapacity=0) to get the rules length without copying them to
 * the binaryRules buffer. However, whether preflighting or not, if the actual length
 * is greater than INT32_MAX, then the function returns 0 and sets *status to
 * U_INDEX_OUTOFBOUNDS_ERROR.

 * @param bi            The break iterator to use.
 * @param binaryRules   Buffer to receive the compiled binary rules; set to NULL for
 *                      preflighting.
 * @param rulesCapacity Capacity (in bytes) of the binaryRules buffer; set to 0 for
 *                      preflighting. Must be >= 0.
 * @param status        Pointer to UErrorCode to receive any errors, such as
 *                      U_BUFFER_OVERFLOW_ERROR, U_INDEX_OUTOFBOUNDS_ERROR, or
 *                      U_ILLEGAL_ARGUMENT_ERROR.
 * @return              The actual byte length of the binary rules, if <= INT32_MAX;
 *                      otherwise 0. If not preflighting and this is larger than
 *                      rulesCapacity, *status will be set to an error.
 * @see ubrk_openBinaryRules
 * @stable ICU 59
 */
U_CAPI int32_t U_EXPORT2
ubrk_getBinaryRules(UBreakIterator *bi,
                    uint8_t *       binaryRules, int32_t rulesCapacity,
                    UErrorCode *    status);

#endif /* #if !UCONFIG_NO_BREAK_ITERATION */

#endif
