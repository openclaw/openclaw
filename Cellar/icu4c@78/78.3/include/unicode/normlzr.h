// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 ********************************************************************
 * COPYRIGHT:
 * Copyright (c) 1996-2015, International Business Machines Corporation and
 * others. All Rights Reserved.
 ********************************************************************
 */

#ifndef NORMLZR_H
#define NORMLZR_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: Unicode Normalization
 */
 
#if !UCONFIG_NO_NORMALIZATION

#include "unicode/chariter.h"
#include "unicode/normalizer2.h"
#include "unicode/unistr.h"
#include "unicode/unorm.h"
#include "unicode/uobject.h"

U_NAMESPACE_BEGIN
/**
 * Old Unicode normalization API.
 *
 * This API has been replaced by the Normalizer2 class and is only available
 * for backward compatibility. This class simply delegates to the Normalizer2 class.
 * There is one exception: The new API does not provide a replacement for Normalizer::compare().
 *
 * The Normalizer class supports the standard normalization forms described in
 * <a href="http://www.unicode.org/unicode/reports/tr15/" target="unicode">
 * Unicode Standard Annex #15: Unicode Normalization Forms</a>.
 *
 * The Normalizer class consists of two parts:
 * - static functions that normalize strings or test if strings are normalized
 * - a Normalizer object is an iterator that takes any kind of text and
 *   provides iteration over its normalized form
 *
 * The Normalizer class is not suitable for subclassing.
 *
 * For basic information about normalization forms and details about the C API
 * please see the documentation in unorm.h.
 *
 * The iterator API with the Normalizer constructors and the non-static functions
 * use a CharacterIterator as input. It is possible to pass a string which
 * is then internally wrapped in a CharacterIterator.
 * The input text is not normalized all at once, but incrementally where needed
 * (providing efficient random access).
 * This allows to pass in a large text but spend only a small amount of time
 * normalizing a small part of that text.
 * However, if the entire text is normalized, then the iterator will be
 * slower than normalizing the entire text at once and iterating over the result.
 * A possible use of the Normalizer iterator is also to report an index into the
 * original text that is close to where the normalized characters come from.
 *
 * <em>Important:</em> The iterator API was cleaned up significantly for ICU 2.0.
 * The earlier implementation reported the getIndex() inconsistently,
 * and previous() could not be used after setIndex(), next(), first(), and current().
 *
 * Normalizer allows to start normalizing from anywhere in the input text by
 * calling setIndexOnly(), first(), or last().
 * Without calling any of these, the iterator will start at the beginning of the text.
 *
 * At any time, next() returns the next normalized code point (UChar32),
 * with post-increment semantics (like CharacterIterator::next32PostInc()).
 * previous() returns the previous normalized code point (UChar32),
 * with pre-decrement semantics (like CharacterIterator::previous32()).
 *
 * current() returns the current code point
 * (respectively the one at the newly set index) without moving
 * the getIndex(). Note that if the text at the current position
 * needs to be normalized, then these functions will do that.
 * (This is why current() is not const.)
 * It is more efficient to call setIndexOnly() instead, which does not
 * normalize.
 *
 * getIndex() always refers to the position in the input text where the normalized
 * code points are returned from. It does not always change with each returned
 * code point.
 * The code point that is returned from any of the functions
 * corresponds to text at or after getIndex(), according to the
 * function's iteration semantics (post-increment or pre-decrement).
 *
 * next() returns a code point from at or after the getIndex()
 * from before the next() call. After the next() call, the getIndex()
 * might have moved to where the next code point will be returned from
 * (from a next() or current() call).
 * This is semantically equivalent to array access with array[index++]
 * (post-increment semantics).
 *
 * previous() returns a code point from at or after the getIndex()
 * from after the previous() call.
 * This is semantically equivalent to array access with array[--index]
 * (pre-decrement semantics).
 *
 * Internally, the Normalizer iterator normalizes a small piece of text
 * starting at the getIndex() and ending at a following "safe" index.
 * The normalized results is stored in an internal string buffer, and
 * the code points are iterated from there.
 * With multiple iteration calls, this is repeated until the next piece
 * of text needs to be normalized, and the getIndex() needs to be moved.
 *
 * The following "safe" index, the internal buffer, and the secondary
 * iteration index into that buffer are not exposed on the API.
 * This also means that it is currently not practical to return to
 * a particular, arbitrary position in the text because one would need to
 * know, and be able to set, in addition to the getIndex(), at least also the
 * current index into the internal buffer.
 * It is currently only possible to observe when getIndex() changes
 * (with careful consideration of the iteration semantics),
 * at which time the internal index will be 0.
 * For example, if getIndex() is different after next() than before it,
 * then the internal index is 0 and one can return to this getIndex()
 * later with setIndexOnly().
 *
 * Note: While the setIndex() and getIndex() refer to indices in the
 * underlying Unicode input text, the next() and previous() methods
 * iterate through characters in the normalized output.
 * This means that there is not necessarily a one-to-one correspondence
 * between characters returned by next() and previous() and the indices
 * passed to and returned from setIndex() and getIndex().
 * It is for this reason that Normalizer does not implement the CharacterIterator interface.
 *
 * @author Laura Werner, Mark Davis, Markus Scherer
 * @stable ICU 2.0
 */
class U_COMMON_API Normalizer : public UObject {
public:
#ifndef U_HIDE_DEPRECATED_API
  /**
   * If DONE is returned from an iteration function that returns a code point,
   * then there are no more normalization results available.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  enum {
      DONE=0xffff
  };

  // Constructors

  /**
   * Creates a new <code>Normalizer</code> object for iterating over the
   * normalized form of a given string.
   * <p>
   * @param str   The string to be normalized.  The normalization
   *              will start at the beginning of the string.
   *
   * @param mode  The normalization mode.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  Normalizer(const UnicodeString& str, UNormalizationMode mode);

  /**
   * Creates a new <code>Normalizer</code> object for iterating over the
   * normalized form of a given string.
   * <p>
   * @param str   The string to be normalized.  The normalization
   *              will start at the beginning of the string.
   *
   * @param length Length of the string, or -1 if NUL-terminated.
   * @param mode  The normalization mode.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  Normalizer(ConstChar16Ptr str, int32_t length, UNormalizationMode mode);

  /**
   * Creates a new <code>Normalizer</code> object for iterating over the
   * normalized form of the given text.
   * <p>
   * @param iter  The input text to be normalized.  The normalization
   *              will start at the beginning of the string.
   *
   * @param mode  The normalization mode.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  Normalizer(const CharacterIterator& iter, UNormalizationMode mode);
#endif  /* U_HIDE_DEPRECATED_API */

#ifndef U_FORCE_HIDE_DEPRECATED_API
  /**
   * Copy constructor.
   * @param copy The object to be copied.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  Normalizer(const Normalizer& copy);

  /**
   * Destructor
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  virtual ~Normalizer();
#endif  // U_FORCE_HIDE_DEPRECATED_API

  //-------------------------------------------------------------------------
  // Static utility methods
  //-------------------------------------------------------------------------

#ifndef U_HIDE_DEPRECATED_API
  /**
   * Normalizes a <code>UnicodeString</code> according to the specified normalization mode.
   * This is a wrapper for unorm_normalize(), using UnicodeString's.
   *
   * The <code>options</code> parameter specifies which optional
   * <code>Normalizer</code> features are to be enabled for this operation.
   *
   * @param source    the input string to be normalized.
   * @param mode      the normalization mode
   * @param options   the optional features to be enabled (0 for no options)
   * @param result    The normalized string (on output).
   * @param status    The error code.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static void U_EXPORT2 normalize(const UnicodeString& source,
                        UNormalizationMode mode, int32_t options,
                        UnicodeString& result,
                        UErrorCode &status);

  /**
   * Compose a <code>UnicodeString</code>.
   * This is equivalent to normalize() with mode UNORM_NFC or UNORM_NFKC.
   * This is a wrapper for unorm_normalize(), using UnicodeString's.
   *
   * The <code>options</code> parameter specifies which optional
   * <code>Normalizer</code> features are to be enabled for this operation.
   *
   * @param source    the string to be composed.
   * @param compat    Perform compatibility decomposition before composition.
   *                  If this argument is <code>false</code>, only canonical
   *                  decomposition will be performed.
   * @param options   the optional features to be enabled (0 for no options)
   * @param result    The composed string (on output).
   * @param status    The error code.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static void U_EXPORT2 compose(const UnicodeString& source,
                      UBool compat, int32_t options,
                      UnicodeString& result,
                      UErrorCode &status);

  /**
   * Static method to decompose a <code>UnicodeString</code>.
   * This is equivalent to normalize() with mode UNORM_NFD or UNORM_NFKD.
   * This is a wrapper for unorm_normalize(), using UnicodeString's.
   *
   * The <code>options</code> parameter specifies which optional
   * <code>Normalizer</code> features are to be enabled for this operation.
   *
   * @param source    the string to be decomposed.
   * @param compat    Perform compatibility decomposition.
   *                  If this argument is <code>false</code>, only canonical
   *                  decomposition will be performed.
   * @param options   the optional features to be enabled (0 for no options)
   * @param result    The decomposed string (on output).
   * @param status    The error code.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static void U_EXPORT2 decompose(const UnicodeString& source,
                        UBool compat, int32_t options,
                        UnicodeString& result,
                        UErrorCode &status);

  /**
   * Performing quick check on a string, to quickly determine if the string is
   * in a particular normalization format.
   * This is a wrapper for unorm_quickCheck(), using a UnicodeString.
   *
   * Three types of result can be returned UNORM_YES, UNORM_NO or
   * UNORM_MAYBE. Result UNORM_YES indicates that the argument
   * string is in the desired normalized format, UNORM_NO determines that
   * argument string is not in the desired normalized format. A
   * UNORM_MAYBE result indicates that a more thorough check is required,
   * the user may have to put the string in its normalized form and compare the
   * results.
   * @param source       string for determining if it is in a normalized format
   * @param mode         normalization format
   * @param status A reference to a UErrorCode to receive any errors
   * @return UNORM_YES, UNORM_NO or UNORM_MAYBE
   *
   * @see isNormalized
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static inline UNormalizationCheckResult
  quickCheck(const UnicodeString &source, UNormalizationMode mode, UErrorCode &status);

  /**
   * Performing quick check on a string; same as the other version of quickCheck
   * but takes an extra options parameter like most normalization functions.
   *
   * @param source       string for determining if it is in a normalized format
   * @param mode         normalization format
   * @param options      the optional features to be enabled (0 for no options)
   * @param status A reference to a UErrorCode to receive any errors
   * @return UNORM_YES, UNORM_NO or UNORM_MAYBE
   *
   * @see isNormalized
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static UNormalizationCheckResult
  quickCheck(const UnicodeString &source, UNormalizationMode mode, int32_t options, UErrorCode &status);

  /**
   * Test if a string is in a given normalization form.
   * This is semantically equivalent to source.equals(normalize(source, mode)) .
   *
   * Unlike unorm_quickCheck(), this function returns a definitive result,
   * never a "maybe".
   * For NFD, NFKD, and FCD, both functions work exactly the same.
   * For NFC and NFKC where quickCheck may return "maybe", this function will
   * perform further tests to arrive at a true/false result.
   *
   * @param src        String that is to be tested if it is in a normalization format.
   * @param mode       Which normalization form to test for.
   * @param errorCode  ICU error code in/out parameter.
   *                   Must fulfill U_SUCCESS before the function call.
   * @return Boolean value indicating whether the source string is in the
   *         "mode" normalization form.
   *
   * @see quickCheck
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static inline UBool
  isNormalized(const UnicodeString &src, UNormalizationMode mode, UErrorCode &errorCode);

  /**
   * Test if a string is in a given normalization form; same as the other version of isNormalized
   * but takes an extra options parameter like most normalization functions.
   *
   * @param src        String that is to be tested if it is in a normalization format.
   * @param mode       Which normalization form to test for.
   * @param options      the optional features to be enabled (0 for no options)
   * @param errorCode  ICU error code in/out parameter.
   *                   Must fulfill U_SUCCESS before the function call.
   * @return Boolean value indicating whether the source string is in the
   *         "mode" normalization form.
   *
   * @see quickCheck
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static UBool
  isNormalized(const UnicodeString &src, UNormalizationMode mode, int32_t options, UErrorCode &errorCode);

  /**
   * Concatenate normalized strings, making sure that the result is normalized as well.
   *
   * If both the left and the right strings are in
   * the normalization form according to "mode/options",
   * then the result will be
   *
   * \code
   *     dest=normalize(left+right, mode, options)
   * \endcode
   *
   * For details see unorm_concatenate in unorm.h.
   *
   * @param left Left source string.
   * @param right Right source string.
   * @param result The output string.
   * @param mode The normalization mode.
   * @param options A bit set of normalization options.
   * @param errorCode ICU error code in/out parameter.
   *                   Must fulfill U_SUCCESS before the function call.
   * @return result
   *
   * @see unorm_concatenate
   * @see normalize
   * @see unorm_next
   * @see unorm_previous
   *
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static UnicodeString &
  U_EXPORT2 concatenate(const UnicodeString &left, const UnicodeString &right,
              UnicodeString &result,
              UNormalizationMode mode, int32_t options,
              UErrorCode &errorCode);
#endif  /* U_HIDE_DEPRECATED_API */

  /**
   * Compare two strings for canonical equivalence.
   * Further options include case-insensitive comparison and
   * code point order (as opposed to code unit order).
   *
   * Canonical equivalence between two strings is defined as their normalized
   * forms (NFD or NFC) being identical.
   * This function compares strings incrementally instead of normalizing
   * (and optionally case-folding) both strings entirely,
   * improving performance significantly.
   *
   * Bulk normalization is only necessary if the strings do not fulfill the FCD
   * conditions. Only in this case, and only if the strings are relatively long,
   * is memory allocated temporarily.
   * For FCD strings and short non-FCD strings there is no memory allocation.
   *
   * Semantically, this is equivalent to
   *   strcmp[CodePointOrder](NFD(foldCase(s1)), NFD(foldCase(s2)))
   * where code point order and foldCase are all optional.
   *
   * UAX 21 2.5 Caseless Matching specifies that for a canonical caseless match
   * the case folding must be performed first, then the normalization.
   *
   * @param s1 First source string.
   * @param s2 Second source string.
   *
   * @param options A bit set of options:
   *   - U_FOLD_CASE_DEFAULT or 0 is used for default options:
   *     Case-sensitive comparison in code unit order, and the input strings
   *     are quick-checked for FCD.
   *
   *   - UNORM_INPUT_IS_FCD
   *     Set if the caller knows that both s1 and s2 fulfill the FCD conditions.
   *     If not set, the function will quickCheck for FCD
   *     and normalize if necessary.
   *
   *   - U_COMPARE_CODE_POINT_ORDER
   *     Set to choose code point order instead of code unit order
   *     (see u_strCompare for details).
   *
   *   - U_COMPARE_IGNORE_CASE
   *     Set to compare strings case-insensitively using case folding,
   *     instead of case-sensitively.
   *     If set, then the following case folding options are used.
   *
   *   - Options as used with case-insensitive comparisons, currently:
   *
   *   - U_FOLD_CASE_EXCLUDE_SPECIAL_I
   *    (see u_strCaseCompare for details)
   *
   *   - regular normalization options shifted left by UNORM_COMPARE_NORM_OPTIONS_SHIFT
   *
   * @param errorCode ICU error code in/out parameter.
   *                  Must fulfill U_SUCCESS before the function call.
   * @return <0 or 0 or >0 as usual for string comparisons
   *
   * @see unorm_compare
   * @see normalize
   * @see UNORM_FCD
   * @see u_strCompare
   * @see u_strCaseCompare
   *
   * @stable ICU 2.2
   */
  static inline int32_t
  compare(const UnicodeString &s1, const UnicodeString &s2,
          uint32_t options,
          UErrorCode &errorCode);

#ifndef U_HIDE_DEPRECATED_API
  //-------------------------------------------------------------------------
  // Iteration API
  //-------------------------------------------------------------------------

  /**
   * Return the current character in the normalized text.
   * current() may need to normalize some text at getIndex().
   * The getIndex() is not changed.
   *
   * @return the current normalized code point
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  UChar32 current();

  /**
   * Return the first character in the normalized text.
   * This is equivalent to setIndexOnly(startIndex()) followed by next().
   * (Post-increment semantics.)
   *
   * @return the first normalized code point
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  UChar32 first();

  /**
   * Return the last character in the normalized text.
   * This is equivalent to setIndexOnly(endIndex()) followed by previous().
   * (Pre-decrement semantics.)
   *
   * @return the last normalized code point
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  UChar32 last();

  /**
   * Return the next character in the normalized text.
   * (Post-increment semantics.)
   * If the end of the text has already been reached, DONE is returned.
   * The DONE value could be confused with a U+FFFF non-character code point
   * in the text. If this is possible, you can test getIndex()<endIndex()
   * before calling next(), or (getIndex()<endIndex() || last()!=DONE)
   * after calling next(). (Calling last() will change the iterator state!)
   *
   * The C API unorm_next() is more efficient and does not have this ambiguity.
   *
   * @return the next normalized code point
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  UChar32 next();

  /**
   * Return the previous character in the normalized text and decrement.
   * (Pre-decrement semantics.)
   * If the beginning of the text has already been reached, DONE is returned.
   * The DONE value could be confused with a U+FFFF non-character code point
   * in the text. If this is possible, you can test
   * (getIndex()>startIndex() || first()!=DONE). (Calling first() will change
   * the iterator state!)
   *
   * The C API unorm_previous() is more efficient and does not have this ambiguity.
   *
   * @return the previous normalized code point
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  UChar32 previous();

  /**
   * Set the iteration position in the input text that is being normalized,
   * without any immediate normalization.
   * After setIndexOnly(), getIndex() will return the same index that is
   * specified here.
   *
   * @param index the desired index in the input text.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void                 setIndexOnly(int32_t index);

  /**
   * Reset the index to the beginning of the text.
   * This is equivalent to setIndexOnly(startIndex)).
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void reset();

  /**
   * Retrieve the current iteration position in the input text that is
   * being normalized.
   *
   * A following call to next() will return a normalized code point from
   * the input text at or after this index.
   *
   * After a call to previous(), getIndex() will point at or before the
   * position in the input text where the normalized code point
   * was returned from with previous().
   *
   * @return the current index in the input text
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  int32_t getIndex() const;

  /**
   * Retrieve the index of the start of the input text. This is the begin index
   * of the <code>CharacterIterator</code> or the start (i.e. index 0) of the string
   * over which this <code>Normalizer</code> is iterating.
   *
   * @return the smallest index in the input text where the Normalizer operates
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  int32_t startIndex() const;

  /**
   * Retrieve the index of the end of the input text. This is the end index
   * of the <code>CharacterIterator</code> or the length of the string
   * over which this <code>Normalizer</code> is iterating.
   * This end index is exclusive, i.e., the Normalizer operates only on characters
   * before this index.
   *
   * @return the first index in the input text where the Normalizer does not operate
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  int32_t endIndex() const;

  /**
   * Returns true when both iterators refer to the same character in the same
   * input text.
   *
   * @param that a Normalizer object to compare this one to
   * @return comparison result
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  bool         operator==(const Normalizer& that) const;

  /**
   * Returns false when both iterators refer to the same character in the same
   * input text.
   *
   * @param that a Normalizer object to compare this one to
   * @return comparison result
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  inline bool         operator!=(const Normalizer& that) const;

  /**
   * Returns a pointer to a new Normalizer that is a clone of this one.
   * The caller is responsible for deleting the new clone.
   * @return a pointer to a new Normalizer
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  Normalizer*        clone() const;

  /**
   * Generates a hash code for this iterator.
   *
   * @return the hash code
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  int32_t hashCode() const;

  //-------------------------------------------------------------------------
  // Property access methods
  //-------------------------------------------------------------------------

  /**
   * Set the normalization mode for this object.
   * <p>
   * <b>Note:</b>If the normalization mode is changed while iterating
   * over a string, calls to {@link #next() } and {@link #previous() } may
   * return previously buffers characters in the old normalization mode
   * until the iteration is able to re-sync at the next base character.
   * It is safest to call {@link #setIndexOnly }, {@link #reset() },
   * {@link #setText }, {@link #first() },
   * {@link #last() }, etc. after calling <code>setMode</code>.
   * <p>
   * @param newMode the new mode for this <code>Normalizer</code>.
   * @see #getUMode
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void setMode(UNormalizationMode newMode);

  /**
   * Return the normalization mode for this object.
   *
   * This is an unusual name because there used to be a getMode() that
   * returned a different type.
   *
   * @return the mode for this <code>Normalizer</code>
   * @see #setMode
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  UNormalizationMode getUMode() const;

  /**
   * Set options that affect this <code>Normalizer</code>'s operation.
   * Options do not change the basic composition or decomposition operation
   * that is being performed, but they control whether
   * certain optional portions of the operation are done.
   * Currently the only available option is obsolete.
   *
   * It is possible to specify multiple options that are all turned on or off.
   *
   * @param   option  the option(s) whose value is/are to be set.
   * @param   value   the new setting for the option.  Use <code>true</code> to
   *                  turn the option(s) on and <code>false</code> to turn it/them off.
   *
   * @see #getOption
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void setOption(int32_t option,
         UBool value);

  /**
   * Determine whether an option is turned on or off.
   * If multiple options are specified, then the result is true if any
   * of them are set.
   * <p>
   * @param option the option(s) that are to be checked
   * @return true if any of the option(s) are set
   * @see #setOption
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  UBool getOption(int32_t option) const;

  /**
   * Set the input text over which this <code>Normalizer</code> will iterate.
   * The iteration position is set to the beginning.
   *
   * @param newText a string that replaces the current input text
   * @param status a UErrorCode
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void setText(const UnicodeString& newText,
           UErrorCode &status);

  /**
   * Set the input text over which this <code>Normalizer</code> will iterate.
   * The iteration position is set to the beginning.
   *
   * @param newText a CharacterIterator object that replaces the current input text
   * @param status a UErrorCode
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void setText(const CharacterIterator& newText,
           UErrorCode &status);

  /**
   * Set the input text over which this <code>Normalizer</code> will iterate.
   * The iteration position is set to the beginning.
   *
   * @param newText a string that replaces the current input text
   * @param length the length of the string, or -1 if NUL-terminated
   * @param status a UErrorCode
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void setText(ConstChar16Ptr newText,
                    int32_t length,
            UErrorCode &status);
  /**
   * Copies the input text into the UnicodeString argument.
   *
   * @param result Receives a copy of the text under iteration.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  void            getText(UnicodeString&  result);

  /**
   * ICU "poor man's RTTI", returns a UClassID for this class.
   * @returns a UClassID for this class.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  static UClassID U_EXPORT2 getStaticClassID();
#endif  /* U_HIDE_DEPRECATED_API */

#ifndef U_FORCE_HIDE_DEPRECATED_API
  /**
   * ICU "poor man's RTTI", returns a UClassID for the actual class.
   * @return a UClassID for the actual class.
   * @deprecated ICU 56 Use Normalizer2 instead.
   */
  virtual UClassID getDynamicClassID() const override;
#endif  // U_FORCE_HIDE_DEPRECATED_API

private:
  //-------------------------------------------------------------------------
  // Private functions
  //-------------------------------------------------------------------------

  Normalizer() = delete; // default constructor not implemented
  Normalizer &operator=(const Normalizer &that) = delete; // assignment operator not implemented

  // Private utility methods for iteration
  // For documentation, see the source code
  UBool nextNormalize();
  UBool previousNormalize();

  void    init();
  void clearBuffer();

  //-------------------------------------------------------------------------
  // Private data
  //-------------------------------------------------------------------------

  FilteredNormalizer2*fFilteredNorm2;  // owned if not nullptr
  const Normalizer2  *fNorm2;  // not owned; may be equal to fFilteredNorm2
  UNormalizationMode  fUMode;  // deprecated
  int32_t             fOptions;

  // The input text and our position in it
  CharacterIterator  *text;

  // The normalization buffer is the result of normalization
  // of the source in [currentIndex..nextIndex[ .
  int32_t         currentIndex, nextIndex;

  // A buffer for holding intermediate results
  UnicodeString       buffer;
  int32_t         bufferPos;
};

//-------------------------------------------------------------------------
// Inline implementations
//-------------------------------------------------------------------------

#ifndef U_HIDE_DEPRECATED_API
inline bool
Normalizer::operator!= (const Normalizer& other) const
{ return ! operator==(other); }

inline UNormalizationCheckResult
Normalizer::quickCheck(const UnicodeString& source,
                       UNormalizationMode mode,
                       UErrorCode &status) {
    return quickCheck(source, mode, 0, status);
}

inline UBool
Normalizer::isNormalized(const UnicodeString& source,
                         UNormalizationMode mode,
                         UErrorCode &status) {
    return isNormalized(source, mode, 0, status);
}
#endif  /* U_HIDE_DEPRECATED_API */

inline int32_t
Normalizer::compare(const UnicodeString &s1, const UnicodeString &s2,
                    uint32_t options,
                    UErrorCode &errorCode) {
  // all argument checking is done in unorm_compare
  return unorm_compare(toUCharPtr(s1.getBuffer()), s1.length(),
                       toUCharPtr(s2.getBuffer()), s2.length(),
                       options,
                       &errorCode);
}

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_NORMALIZATION */

#endif // NORMLZR_H

#endif /* U_SHOW_CPLUSPLUS_API */
