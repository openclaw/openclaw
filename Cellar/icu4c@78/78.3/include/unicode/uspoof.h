// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
***************************************************************************
* Copyright (C) 2008-2016, International Business Machines Corporation
* and others. All Rights Reserved.
***************************************************************************
*   file name:  uspoof.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2008Feb13
*   created by: Andy Heninger
*
*   Unicode Spoof Detection
*/

#ifndef USPOOF_H
#define USPOOF_H

#include "unicode/ubidi.h"
#include "unicode/utypes.h"
#include "unicode/uset.h"
#include "unicode/parseerr.h"

#if !UCONFIG_NO_NORMALIZATION


#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#include "unicode/unistr.h"
#include "unicode/uniset.h"
#endif


/**
 * \file
 * \brief C API: Unicode Security and Spoofing Detection
 *
 * <p>
 * This class, based on <a href="http://unicode.org/reports/tr36">Unicode Technical Report #36</a> and
 * <a href="http://unicode.org/reports/tr39">Unicode Technical Standard #39</a>, has two main functions:
 *
 * <ol>
 * <li>Checking whether two strings are visually <em>confusable</em> with each other, such as "Harvest" and
 * &quot;&Eta;arvest&quot;, where the second string starts with the Greek capital letter Eta.</li>
 * <li>Checking whether an individual string is likely to be an attempt at confusing the reader (<em>spoof
 * detection</em>), such as "paypal" with some Latin characters substituted with Cyrillic look-alikes.</li>
 * </ol>
 *
 * <p>
 * Although originally designed as a method for flagging suspicious identifier strings such as URLs,
 * <code>USpoofChecker</code> has a number of other practical use cases, such as preventing attempts to evade bad-word
 * content filters.
 *
 * <p>
 * The functions of this class are exposed as C API, with a handful of syntactical conveniences for C++.
 *
 * <h2>Confusables</h2>
 *
 * <p>
 * The following example shows how to use <code>USpoofChecker</code> to check for confusability between two strings:
 *
 * \code{.c}
 * UErrorCode status = U_ZERO_ERROR;
 * UChar* str1 = (UChar*) u"Harvest";
 * UChar* str2 = (UChar*) u"\u0397arvest";  // with U+0397 GREEK CAPITAL LETTER ETA
 *
 * USpoofChecker* sc = uspoof_open(&status);
 * uspoof_setChecks(sc, USPOOF_CONFUSABLE, &status);
 *
 * int32_t bitmask = uspoof_areConfusable(sc, str1, -1, str2, -1, &status);
 * UBool result = bitmask != 0;
 * // areConfusable: 1 (status: U_ZERO_ERROR)
 * printf("areConfusable: %d (status: %s)\n", result, u_errorName(status));
 * uspoof_close(sc);
 * \endcode
 *
 * <p>
 * The call to {@link uspoof_open} creates a <code>USpoofChecker</code> object; the call to {@link uspoof_setChecks}
 * enables confusable checking and disables all other checks; the call to {@link uspoof_areConfusable} performs the
 * confusability test; and the following line extracts the result out of the return value. For best performance,
 * the instance should be created once (e.g., upon application startup), and the efficient
 * {@link uspoof_areConfusable} method can be used at runtime.
 *
 * If the paragraph direction used to display the strings is known, the bidi function should be used instead:
 *
 * \code{.c}
 * UErrorCode status = U_ZERO_ERROR;
 * // These strings look identical when rendered in a left-to-right context.
 * // They look distinct in a right-to-left context.
 * UChar* str1 = (UChar*) u"A1\u05D0";  // A1א
 * UChar* str2 = (UChar*) u"A\u05D01";  // Aא1
 *
 * USpoofChecker* sc = uspoof_open(&status);
 * uspoof_setChecks(sc, USPOOF_CONFUSABLE, &status);
 *
 * int32_t bitmask = uspoof_areBidiConfusable(sc, UBIDI_LTR, str1, -1, str2, -1, &status);
 * UBool result = bitmask != 0;
 * // areBidiConfusable: 1 (status: U_ZERO_ERROR)
 * printf("areBidiConfusable: %d (status: %s)\n", result, u_errorName(status));
 * uspoof_close(sc);
 * \endcode
 *
 * <p>
 * The type {@link LocalUSpoofCheckerPointer} is exposed for C++ programmers.  It will automatically call
 * {@link uspoof_close} when the object goes out of scope:
 *
 * \code{.cpp}
 * UErrorCode status = U_ZERO_ERROR;
 * LocalUSpoofCheckerPointer sc(uspoof_open(&status));
 * uspoof_setChecks(sc.getAlias(), USPOOF_CONFUSABLE, &status);
 * // ...
 * \endcode
 *
 * UTS 39 defines two strings to be <em>confusable</em> if they map to the same <em>skeleton string</em>. A skeleton can
 * be thought of as a "hash code". {@link uspoof_getSkeleton} computes the skeleton for a particular string, so
 * the following snippet is equivalent to the example above:
 *
 * \code{.c}
 * UErrorCode status = U_ZERO_ERROR;
 * UChar* str1 = (UChar*) u"Harvest";
 * UChar* str2 = (UChar*) u"\u0397arvest";  // with U+0397 GREEK CAPITAL LETTER ETA
 *
 * USpoofChecker* sc = uspoof_open(&status);
 * uspoof_setChecks(sc, USPOOF_CONFUSABLE, &status);
 *
 * // Get skeleton 1
 * int32_t skel1Len = uspoof_getSkeleton(sc, 0, str1, -1, NULL, 0, &status);
 * UChar* skel1 = (UChar*) malloc(++skel1Len * sizeof(UChar));
 * status = U_ZERO_ERROR;
 * uspoof_getSkeleton(sc, 0, str1, -1, skel1, skel1Len, &status);
 *
 * // Get skeleton 2
 * int32_t skel2Len = uspoof_getSkeleton(sc, 0, str2, -1, NULL, 0, &status);
 * UChar* skel2 = (UChar*) malloc(++skel2Len * sizeof(UChar));
 * status = U_ZERO_ERROR;
 * uspoof_getSkeleton(sc, 0, str2, -1, skel2, skel2Len, &status);
 *
 * // Are the skeletons the same?
 * UBool result = u_strcmp(skel1, skel2) == 0;
 * // areConfusable: 1 (status: U_ZERO_ERROR)
 * printf("areConfusable: %d (status: %s)\n", result, u_errorName(status));
 * uspoof_close(sc);
 * free(skel1);
 * free(skel2);
 * \endcode
 *
 * If you need to check if a string is confusable with any string in a dictionary of many strings, rather than calling
 * {@link uspoof_areConfusable} many times in a loop, {@link uspoof_getSkeleton} can be used instead, as shown below:
 *
 * \code{.c}
 * UErrorCode status = U_ZERO_ERROR;
 * #define DICTIONARY_LENGTH 2
 * UChar* dictionary[DICTIONARY_LENGTH] = { (UChar*) u"lorem", (UChar*) u"ipsum" };
 * UChar* skeletons[DICTIONARY_LENGTH];
 * UChar* str = (UChar*) u"1orern";
 *
 * // Setup:
 * USpoofChecker* sc = uspoof_open(&status);
 * uspoof_setChecks(sc, USPOOF_CONFUSABLE, &status);
 * for (size_t i=0; i<DICTIONARY_LENGTH; i++) {
 *     UChar* word = dictionary[i];
 *     int32_t len = uspoof_getSkeleton(sc, 0, word, -1, NULL, 0, &status);
 *     skeletons[i] = (UChar*) malloc(++len * sizeof(UChar));
 *     status = U_ZERO_ERROR;
 *     uspoof_getSkeleton(sc, 0, word, -1, skeletons[i], len, &status);
 * }
 *
 * // Live Check:
 * {
 *     int32_t len = uspoof_getSkeleton(sc, 0, str, -1, NULL, 0, &status);
 *     UChar* skel = (UChar*) malloc(++len * sizeof(UChar));
 *     status = U_ZERO_ERROR;
 *     uspoof_getSkeleton(sc, 0, str, -1, skel, len, &status);
 *     UBool result = false;
 *     for (size_t i=0; i<DICTIONARY_LENGTH; i++) {
 *         result = u_strcmp(skel, skeletons[i]) == 0;
 *         if (result == true) { break; }
 *     }
 *     // Has confusable in dictionary: 1 (status: U_ZERO_ERROR)
 *     printf("Has confusable in dictionary: %d (status: %s)\n", result, u_errorName(status));
 *     free(skel);
 * }
 *
 * for (size_t i=0; i<DICTIONARY_LENGTH; i++) {
 *     free(skeletons[i]);
 * }
 * uspoof_close(sc);
 * \endcode
 *
 * <b>Note:</b> Since the Unicode confusables mapping table is frequently updated, confusable skeletons are <em>not</em>
 * guaranteed to be the same between ICU releases. We therefore recommend that you always compute confusable skeletons
 * at runtime and do not rely on creating a permanent, or difficult to update, database of skeletons.
 *
 * <h2>Spoof Detection</h2>
 *
 * The following snippet shows a minimal example of using <code>USpoofChecker</code> to perform spoof detection on a
 * string:
 *
 * \code{.c}
 * UErrorCode status = U_ZERO_ERROR;
 * UChar* str = (UChar*) u"p\u0430ypal";  // with U+0430 CYRILLIC SMALL LETTER A
 *
 * // Get the default set of allowable characters:
 * USet* allowed = uset_openEmpty();
 * uset_addAll(allowed, uspoof_getRecommendedSet(&status));
 * uset_addAll(allowed, uspoof_getInclusionSet(&status));
 *
 * USpoofChecker* sc = uspoof_open(&status);
 * uspoof_setAllowedChars(sc, allowed, &status);
 * uspoof_setRestrictionLevel(sc, USPOOF_MODERATELY_RESTRICTIVE);
 *
 * int32_t bitmask = uspoof_check(sc, str, -1, NULL, &status);
 * UBool result = bitmask != 0;
 * // fails checks: 1 (status: U_ZERO_ERROR)
 * printf("fails checks: %d (status: %s)\n", result, u_errorName(status));
 * uspoof_close(sc);
 * uset_close(allowed);
 * \endcode
 *
 * As in the case for confusability checking, it is good practice to create one <code>USpoofChecker</code> instance at
 * startup, and call the cheaper {@link uspoof_check} online. We specify the set of
 * allowed characters to be those with type RECOMMENDED or INCLUSION, according to the recommendation in UTS 39.
 *
 * In addition to {@link uspoof_check}, the function {@link uspoof_checkUTF8} is exposed for UTF8-encoded char* strings,
 * and {@link uspoof_checkUnicodeString} is exposed for C++ programmers.
 *
 * If the {@link USPOOF_AUX_INFO} check is enabled, a limited amount of information on why a string failed the checks
 * is available in the returned bitmask.  For complete information, use the {@link uspoof_check2} class of functions
 * with a {@link USpoofCheckResult} parameter:
 *
 * \code{.c}
 * UErrorCode status = U_ZERO_ERROR;
 * UChar* str = (UChar*) u"p\u0430ypal";  // with U+0430 CYRILLIC SMALL LETTER A
 *
 * // Get the default set of allowable characters:
 * USet* allowed = uset_openEmpty();
 * uset_addAll(allowed, uspoof_getRecommendedSet(&status));
 * uset_addAll(allowed, uspoof_getInclusionSet(&status));
 *
 * USpoofChecker* sc = uspoof_open(&status);
 * uspoof_setAllowedChars(sc, allowed, &status);
 * uspoof_setRestrictionLevel(sc, USPOOF_MODERATELY_RESTRICTIVE);
 *
 * USpoofCheckResult* checkResult = uspoof_openCheckResult(&status);
 * int32_t bitmask = uspoof_check2(sc, str, -1, checkResult, &status);
 *
 * int32_t failures1 = bitmask;
 * int32_t failures2 = uspoof_getCheckResultChecks(checkResult, &status);
 * assert(failures1 == failures2);
 * // checks that failed: 0x00000010 (status: U_ZERO_ERROR)
 * printf("checks that failed: %#010x (status: %s)\n", failures1, u_errorName(status));
 *
 * // Cleanup:
 * uspoof_close(sc);
 * uset_close(allowed);
 * uspoof_closeCheckResult(checkResult);
 * \endcode
 *
 * C++ users can take advantage of a few syntactical conveniences.  The following snippet is functionally
 * equivalent to the one above:
 *
 * \code{.cpp}
 * UErrorCode status = U_ZERO_ERROR;
 * UnicodeString str((UChar*) u"p\u0430ypal");  // with U+0430 CYRILLIC SMALL LETTER A
 *
 * // Get the default set of allowable characters:
 * UnicodeSet allowed;
 * allowed.addAll(*uspoof_getRecommendedUnicodeSet(&status));
 * allowed.addAll(*uspoof_getInclusionUnicodeSet(&status));
 *
 * LocalUSpoofCheckerPointer sc(uspoof_open(&status));
 * uspoof_setAllowedChars(sc.getAlias(), allowed.toUSet(), &status);
 * uspoof_setRestrictionLevel(sc.getAlias(), USPOOF_MODERATELY_RESTRICTIVE);
 *
 * LocalUSpoofCheckResultPointer checkResult(uspoof_openCheckResult(&status));
 * int32_t bitmask = uspoof_check2UnicodeString(sc.getAlias(), str, checkResult.getAlias(), &status);
 *
 * int32_t failures1 = bitmask;
 * int32_t failures2 = uspoof_getCheckResultChecks(checkResult.getAlias(), &status);
 * assert(failures1 == failures2);
 * // checks that failed: 0x00000010 (status: U_ZERO_ERROR)
 * printf("checks that failed: %#010x (status: %s)\n", failures1, u_errorName(status));
 *
 * // Explicit cleanup not necessary.
 * \endcode
 *
 * The return value is a bitmask of the checks that failed. In this case, there was one check that failed:
 * {@link USPOOF_RESTRICTION_LEVEL}, corresponding to the fifth bit (16). The possible checks are:
 *
 * <ul>
 * <li><code>RESTRICTION_LEVEL</code>: flags strings that violate the
 * <a href="http://unicode.org/reports/tr39/#Restriction_Level_Detection">Restriction Level</a> test as specified in UTS
 * 39; in most cases, this means flagging strings that contain characters from multiple different scripts.</li>
 * <li><code>INVISIBLE</code>: flags strings that contain invisible characters, such as zero-width spaces, or character
 * sequences that are likely not to display, such as multiple occurrences of the same non-spacing mark.</li>
 * <li><code>CHAR_LIMIT</code>: flags strings that contain characters outside of a specified set of acceptable
 * characters. See {@link uspoof_setAllowedChars} and {@link uspoof_setAllowedLocales}.</li>
 * <li><code>MIXED_NUMBERS</code>: flags strings that contain digits from multiple different numbering systems.</li>
 * </ul>
 *
 * <p>
 * These checks can be enabled independently of each other. For example, if you were interested in checking for only the
 * INVISIBLE and MIXED_NUMBERS conditions, you could do:
 *
 * \code{.c}
 * UErrorCode status = U_ZERO_ERROR;
 * UChar* str = (UChar*) u"8\u09EA";  // 8 mixed with U+09EA BENGALI DIGIT FOUR
 *
 * USpoofChecker* sc = uspoof_open(&status);
 * uspoof_setChecks(sc, USPOOF_INVISIBLE | USPOOF_MIXED_NUMBERS, &status);
 *
 * int32_t bitmask = uspoof_check2(sc, str, -1, NULL, &status);
 * UBool result = bitmask != 0;
 * // fails checks: 1 (status: U_ZERO_ERROR)
 * printf("fails checks: %d (status: %s)\n", result, u_errorName(status));
 * uspoof_close(sc);
 * \endcode
 *
 * Here is an example in C++ showing how to compute the restriction level of a string:
 *
 * \code{.cpp}
 * UErrorCode status = U_ZERO_ERROR;
 * UnicodeString str((UChar*) u"p\u0430ypal");  // with U+0430 CYRILLIC SMALL LETTER A
 *
 * // Get the default set of allowable characters:
 * UnicodeSet allowed;
 * allowed.addAll(*uspoof_getRecommendedUnicodeSet(&status));
 * allowed.addAll(*uspoof_getInclusionUnicodeSet(&status));
 *
 * LocalUSpoofCheckerPointer sc(uspoof_open(&status));
 * uspoof_setAllowedChars(sc.getAlias(), allowed.toUSet(), &status);
 * uspoof_setRestrictionLevel(sc.getAlias(), USPOOF_MODERATELY_RESTRICTIVE);
 * uspoof_setChecks(sc.getAlias(), USPOOF_RESTRICTION_LEVEL | USPOOF_AUX_INFO, &status);
 *
 * LocalUSpoofCheckResultPointer checkResult(uspoof_openCheckResult(&status));
 * int32_t bitmask = uspoof_check2UnicodeString(sc.getAlias(), str, checkResult.getAlias(), &status);
 *
 * URestrictionLevel restrictionLevel = uspoof_getCheckResultRestrictionLevel(checkResult.getAlias(), &status);
 * // Since USPOOF_AUX_INFO was enabled, the restriction level is also available in the upper bits of the bitmask:
 * assert((restrictionLevel & bitmask) == restrictionLevel);
 * // Restriction level: 0x50000000 (status: U_ZERO_ERROR)
 * printf("Restriction level: %#010x (status: %s)\n", restrictionLevel, u_errorName(status));
 * \endcode
 *
 * The code '0x50000000' corresponds to the restriction level USPOOF_MINIMALLY_RESTRICTIVE.  Since
 * USPOOF_MINIMALLY_RESTRICTIVE is weaker than USPOOF_MODERATELY_RESTRICTIVE, the string fails the check.
 *
 * <b>Note:</b> The Restriction Level is the most powerful of the checks. The full logic is documented in
 * <a href="http://unicode.org/reports/tr39/#Restriction_Level_Detection">UTS 39</a>, but the basic idea is that strings
 * are restricted to contain characters from only a single script, <em>except</em> that most scripts are allowed to have
 * Latin characters interspersed. Although the default restriction level is <code>HIGHLY_RESTRICTIVE</code>, it is
 * recommended that users set their restriction level to <code>MODERATELY_RESTRICTIVE</code>, which allows Latin mixed
 * with all other scripts except Cyrillic, Greek, and Cherokee, with which it is often confusable. For more details on
 * the levels, see UTS 39 or {@link URestrictionLevel}. The Restriction Level test is aware of the set of
 * allowed characters set in {@link uspoof_setAllowedChars}. Note that characters which have script code
 * COMMON or INHERITED, such as numbers and punctuation, are ignored when computing whether a string has multiple
 * scripts.
 *
 * <h2>Advanced bidirectional usage</h2>
 * If the paragraph direction with which the identifiers will be displayed is not known, there are
 * multiple options for confusable detection depending on the circumstances.
 *
 * <p>
 * In some circumstances, the only concern is confusion between identifiers displayed with the same
 * paragraph direction.
 *
 * <p>
 * An example is the case where identifiers are usernames prefixed with the @ symbol.
 * That symbol will appear to the left in a left-to-right context, and to the right in a
 * right-to-left context, so that an identifier displayed in a left-to-right context can never be
 * confused with an identifier displayed in a right-to-left context:
 * <ul>
 * <li>
 * The usernames "A1א" (A one aleph) and "Aא1" (A aleph 1)
 * would be considered confusable, since they both appear as \@A1א in a left-to-right context, and the
 * usernames "אA_1" (aleph A underscore one) and "א1_A" (aleph one underscore A) would be considered
 * confusable, since they both appear as A_1א@ in a right-to-left context.
 * </li>
 * <li>
 * The username "Mark_" would not be considered confusable with the username "_Mark",
 * even though the latter would appear as Mark_@ in a right-to-left context, and the
 * former as \@Mark_ in a left-to-right context.
 * </li>
 * </ul>
 * <p>
 * In that case, the caller should check for both LTR-confusability and RTL-confusability:
 *
 * \code{.cpp}
 * bool confusableInEitherDirection =
 *     uspoof_areBidiConfusableUnicodeString(sc, UBIDI_LTR, id1, id2, &status) ||
 *     uspoof_areBidiConfusableUnicodeString(sc, UBIDI_RTL, id1, id2, &status);
 * \endcode
 *
 * If the bidiSkeleton is used, the LTR and RTL skeleta should be kept separately and compared, LTR
 * with LTR and RTL with RTL.
 *
 * <p>
 * In cases where confusability between the visual appearances of an identifier displayed in a
 * left-to-right context with another identifier displayed in a right-to-left context is a concern,
 * the LTR skeleton of one can be compared with the RTL skeleton of the other.  However, this
 * very broad definition of confusability may have unexpected results; for instance, it treats the
 * ASCII identifiers "Mark_" and "_Mark" as confusable.
 *
 * <h2>Additional Information</h2>
 *
 * A <code>USpoofChecker</code> instance may be used repeatedly to perform checks on any number of identifiers.
 *
 * <b>Thread Safety:</b> The test functions for checking a single identifier, or for testing whether
 * two identifiers are possible confusable, are thread safe. They may called concurrently, from multiple threads,
 * using the same USpoofChecker instance.
 *
 * More generally, the standard ICU thread safety rules apply: functions that take a const USpoofChecker parameter are
 * thread safe. Those that take a non-const USpoofChecker are not thread safe..
 *
 * @stable ICU 4.6
 */

U_CDECL_BEGIN

struct USpoofChecker;
/**
 * @stable ICU 4.2
 */
typedef struct USpoofChecker USpoofChecker; /**< typedef for C of USpoofChecker */

struct USpoofCheckResult;
/**
 * @see uspoof_openCheckResult
 * @stable ICU 58
 */
typedef struct USpoofCheckResult USpoofCheckResult;

/**
 * Enum for the kinds of checks that USpoofChecker can perform.
 * These enum values are used both to select the set of checks that
 * will be performed, and to report results from the check function.
 *
 * @stable ICU 4.2
 */
typedef enum USpoofChecks {
    /**
     * When performing the two-string {@link uspoof_areConfusable} test, this flag in the return value indicates
     * that the two strings are visually confusable and that they are from the same script, according to UTS 39 section
     * 4.
     *
     * @see uspoof_areConfusable
     * @stable ICU 4.2
     */
    USPOOF_SINGLE_SCRIPT_CONFUSABLE =   1,

    /**
     * When performing the two-string {@link uspoof_areConfusable} test, this flag in the return value indicates
     * that the two strings are visually confusable and that they are <b>not</b> from the same script, according to UTS
     * 39 section 4.
     *
     * @see uspoof_areConfusable
     * @stable ICU 4.2
     */
    USPOOF_MIXED_SCRIPT_CONFUSABLE  =   2,

    /**
     * When performing the two-string {@link uspoof_areConfusable} test, this flag in the return value indicates
     * that the two strings are visually confusable and that they are not from the same script but both of them are
     * single-script strings, according to UTS 39 section 4.
     *
     * @see uspoof_areConfusable
     * @stable ICU 4.2
     */
    USPOOF_WHOLE_SCRIPT_CONFUSABLE  =   4,

    /**
     * Enable this flag in {@link uspoof_setChecks} to turn on all types of confusables.  You may set
     * the checks to some subset of SINGLE_SCRIPT_CONFUSABLE, MIXED_SCRIPT_CONFUSABLE, or WHOLE_SCRIPT_CONFUSABLE to
     * make {@link uspoof_areConfusable} return only those types of confusables.
     *
     * @see uspoof_areConfusable
     * @see uspoof_getSkeleton
     * @stable ICU 58
     */
    USPOOF_CONFUSABLE               =   USPOOF_SINGLE_SCRIPT_CONFUSABLE | USPOOF_MIXED_SCRIPT_CONFUSABLE | USPOOF_WHOLE_SCRIPT_CONFUSABLE,

#ifndef U_HIDE_DEPRECATED_API
    /**
      * This flag is deprecated and no longer affects the behavior of SpoofChecker.
      *
      * @deprecated ICU 58  Any case confusable mappings were removed from UTS 39; the corresponding ICU API was deprecated.
      */
    USPOOF_ANY_CASE                 =   8,
#endif  /* U_HIDE_DEPRECATED_API */

    /**
      * Check that an identifier is no looser than the specified RestrictionLevel.
      * The default if {@link uspoof_setRestrictionLevel} is not called is HIGHLY_RESTRICTIVE.
      *
      * If USPOOF_AUX_INFO is enabled the actual restriction level of the
      * identifier being tested will also be returned by uspoof_check().
      *
      * @see URestrictionLevel
      * @see uspoof_setRestrictionLevel
      * @see USPOOF_AUX_INFO
      *
      * @stable ICU 51
      */
    USPOOF_RESTRICTION_LEVEL        = 16,

#ifndef U_HIDE_DEPRECATED_API
    /** Check that an identifier contains only characters from a
      * single script (plus chars from the common and inherited scripts.)
      * Applies to checks of a single identifier check only.
      * @deprecated ICU 51  Use RESTRICTION_LEVEL instead.
      */
    USPOOF_SINGLE_SCRIPT            =  USPOOF_RESTRICTION_LEVEL,
#endif  /* U_HIDE_DEPRECATED_API */

    /** Check an identifier for the presence of invisible characters,
      * such as zero-width spaces, or character sequences that are
      * likely not to display, such as multiple occurrences of the same
      * non-spacing mark.  This check does not test the input string as a whole
      * for conformance to any particular syntax for identifiers.
      */
    USPOOF_INVISIBLE                =  32,

    /** Check that an identifier contains only characters from a specified set
      * of acceptable characters.  See {@link uspoof_setAllowedChars} and
      * {@link uspoof_setAllowedLocales}.  Note that a string that fails this check
      * will also fail the {@link USPOOF_RESTRICTION_LEVEL} check.
      */
    USPOOF_CHAR_LIMIT               =  64,

    /**
     * Check that an identifier does not mix numbers from different numbering systems.
     * For more information, see UTS 39 section 5.3.
     *
     * @stable ICU 51
     */
    USPOOF_MIXED_NUMBERS            = 128,

    /**
     * Check that an identifier does not have a combining character following a character in which that
     * combining character would be hidden; for example 'i' followed by a U+0307 combining dot.
     *
     * More specifically, the following characters are forbidden from preceding a U+0307:
     * <ul>
     * <li>Those with the Soft_Dotted Unicode property (which includes 'i' and 'j')</li>
     * <li>Latin lowercase letter 'l'</li>
     * <li>Dotless 'i' and 'j' ('ı' and 'ȷ', U+0131 and U+0237)</li>
     * <li>Any character whose confusable prototype ends with such a character
     * (Soft_Dotted, 'l', 'ı', or 'ȷ')</li>
     * </ul>
     * In addition, combining characters are allowed between the above characters and U+0307 except those
     * with combining class 0 or combining class "Above" (230, same class as U+0307).
     *
     * This list and the number of combing characters considered by this check may grow over time.
     *
     * @stable ICU 62
     */
    USPOOF_HIDDEN_OVERLAY            = 256,

   /**
     * Enable all spoof checks.
     *
     * @stable ICU 4.6
     */
    USPOOF_ALL_CHECKS               = 0xFFFF,

    /**
      * Enable the return of auxiliary (non-error) information in the
      * upper bits of the check results value.
      *
      * If this "check" is not enabled, the results of {@link uspoof_check} will be
      * zero when an identifier passes all of the enabled checks.
      *
      * If this "check" is enabled, (uspoof_check() & {@link USPOOF_ALL_CHECKS}) will
      * be zero when an identifier passes all checks.
      *
      * @stable ICU 51
      */
    USPOOF_AUX_INFO                  = 0x40000000

    } USpoofChecks;


    /**
     * Constants from UTS #39 for use in {@link uspoof_setRestrictionLevel}, and
     * for returned identifier restriction levels in check results.
     *
     * @stable ICU 51
     *
     * @see uspoof_setRestrictionLevel
     * @see uspoof_check
     */
    typedef enum URestrictionLevel {
        /**
         * All characters in the string are in the identifier profile and all characters in the string are in the
         * ASCII range.
         *
         * @stable ICU 51
         */
        USPOOF_ASCII = 0x10000000,
        /**
         * The string classifies as ASCII-Only, or all characters in the string are in the identifier profile and
         * the string is single-script, according to the definition in UTS 39 section 5.1.
         *
         * @stable ICU 53
         */
        USPOOF_SINGLE_SCRIPT_RESTRICTIVE = 0x20000000,
        /**
         * The string classifies as Single Script, or all characters in the string are in the identifier profile and
         * the string is covered by any of the following sets of scripts, according to the definition in UTS 39
         * section 5.1:
         * <ul>
         *   <li>Latin + Han + Bopomofo (or equivalently: Latn + Hanb)</li>
         *   <li>Latin + Han + Hiragana + Katakana (or equivalently: Latn + Jpan)</li>
         *   <li>Latin + Han + Hangul (or equivalently: Latn +Kore)</li>
         * </ul>
         * This is the default restriction in ICU.
         *
         * @stable ICU 51
         */
        USPOOF_HIGHLY_RESTRICTIVE = 0x30000000,
        /**
         * The string classifies as Highly Restrictive, or all characters in the string are in the identifier profile
         * and the string is covered by Latin and any one other Recommended or Aspirational script, except Cyrillic,
         * Greek, and Cherokee.
         *
         * @stable ICU 51
         */
        USPOOF_MODERATELY_RESTRICTIVE = 0x40000000,
        /**
         * All characters in the string are in the identifier profile.  Allow arbitrary mixtures of scripts.
         *
         * @stable ICU 51
         */
        USPOOF_MINIMALLY_RESTRICTIVE = 0x50000000,
        /**
         * Any valid identifiers, including characters outside of the Identifier Profile.
         *
         * @stable ICU 51
         */
        USPOOF_UNRESTRICTIVE = 0x60000000,
        /**
         * Mask for selecting the Restriction Level bits from the return value of {@link uspoof_check}.
         *
         * @stable ICU 53
         */
        USPOOF_RESTRICTION_LEVEL_MASK = 0x7F000000,
#ifndef U_HIDE_INTERNAL_API
        /**
         * An undefined restriction level.
         * @internal
         */
        USPOOF_UNDEFINED_RESTRICTIVE = -1
#endif  /* U_HIDE_INTERNAL_API */
    } URestrictionLevel;

/**
 *  Create a Unicode Spoof Checker, configured to perform all
 *  checks except for USPOOF_LOCALE_LIMIT and USPOOF_CHAR_LIMIT.
 *  Note that additional checks may be added in the future,
 *  resulting in the changes to the default checking behavior.
 *
 *  @param status  The error code, set if this function encounters a problem.
 *  @return        the newly created Spoof Checker
 *  @stable ICU 4.2
 */
U_CAPI USpoofChecker * U_EXPORT2
uspoof_open(UErrorCode *status);


/**
 * Open a Spoof checker from its serialized form, stored in 32-bit-aligned memory.
 * Inverse of uspoof_serialize().
 * The memory containing the serialized data must remain valid and unchanged
 * as long as the spoof checker, or any cloned copies of the spoof checker,
 * are in use.  Ownership of the memory remains with the caller.
 * The spoof checker (and any clones) must be closed prior to deleting the
 * serialized data.
 *
 * @param data a pointer to 32-bit-aligned memory containing the serialized form of spoof data
 * @param length the number of bytes available at data;
 *               can be more than necessary
 * @param pActualLength receives the actual number of bytes at data taken up by the data;
 *                      can be NULL
 * @param pErrorCode ICU error code
 * @return the spoof checker.
 *
 * @see uspoof_open
 * @see uspoof_serialize
 * @stable ICU 4.2
 */
U_CAPI USpoofChecker * U_EXPORT2
uspoof_openFromSerialized(const void *data, int32_t length, int32_t *pActualLength,
                          UErrorCode *pErrorCode);

/**
  * Open a Spoof Checker from the source form of the spoof data.
  * The input corresponds to the Unicode data file confusables.txt
  * as described in Unicode Technical Standard #39.  The syntax of the source data
  * is as described in UTS #39 for this file, and the content of
  * this file is acceptable input.
  *
  * The character encoding of the (char *) input text is UTF-8.
  *
  * @param confusables a pointer to the confusable characters definitions,
  *                    as found in file confusables.txt from unicode.org.
  * @param confusablesLen The length of the confusables text, or -1 if the
  *                    input string is zero terminated.
  * @param confusablesWholeScript
  *                    Deprecated in ICU 58.  No longer used.
  * @param confusablesWholeScriptLen
  *                    Deprecated in ICU 58.  No longer used.
  * @param errType     In the event of an error in the input, indicates
  *                    which of the input files contains the error.
  *                    The value is one of USPOOF_SINGLE_SCRIPT_CONFUSABLE or
  *                    USPOOF_WHOLE_SCRIPT_CONFUSABLE, or
  *                    zero if no errors are found.
  * @param pe          In the event of an error in the input, receives the position
  *                    in the input text (line, offset) of the error.
  * @param status      an in/out ICU UErrorCode.  Among the possible errors is
  *                    U_PARSE_ERROR, which is used to report syntax errors
  *                    in the input.
  * @return            A spoof checker that uses the rules from the input files.
  * @stable ICU 4.2
  */
U_CAPI USpoofChecker * U_EXPORT2
uspoof_openFromSource(const char *confusables,  int32_t confusablesLen,
                      const char *confusablesWholeScript, int32_t confusablesWholeScriptLen,
                      int32_t *errType, UParseError *pe, UErrorCode *status);


/**
  * Close a Spoof Checker, freeing any memory that was being held by
  *   its implementation.
  * @stable ICU 4.2
  */
U_CAPI void U_EXPORT2
uspoof_close(USpoofChecker *sc);

/**
 * Clone a Spoof Checker.  The clone will be set to perform the same checks
 *   as the original source.
 *
 * @param sc       The source USpoofChecker
 * @param status   The error code, set if this function encounters a problem.
 * @return
 * @stable ICU 4.2
 */
U_CAPI USpoofChecker * U_EXPORT2
uspoof_clone(const USpoofChecker *sc, UErrorCode *status);


/**
 * Specify the bitmask of checks that will be performed by {@link uspoof_check}. Calling this method
 * overwrites any checks that may have already been enabled. By default, all checks are enabled.
 *
 * To enable specific checks and disable all others,
 * OR together only the bit constants for the desired checks.
 * For example, to fail strings containing characters outside of
 * the set specified by {@link uspoof_setAllowedChars} and
 * also strings that contain digits from mixed numbering systems:
 *
 * <pre>
 * {@code
 * uspoof_setChecks(USPOOF_CHAR_LIMIT | USPOOF_MIXED_NUMBERS);
 * }
 * </pre>
 *
 * To disable specific checks and enable all others,
 * start with ALL_CHECKS and "AND away" the not-desired checks.
 * For example, if you are not planning to use the {@link uspoof_areConfusable} functionality,
 * it is good practice to disable the CONFUSABLE check:
 *
 * <pre>
 * {@code
 * uspoof_setChecks(USPOOF_ALL_CHECKS & ~USPOOF_CONFUSABLE);
 * }
 * </pre>
 *
 * Note that methods such as {@link uspoof_setAllowedChars}, {@link uspoof_setAllowedLocales}, and
 * {@link uspoof_setRestrictionLevel} will enable certain checks when called. Those methods will OR the check they
 * enable onto the existing bitmask specified by this method. For more details, see the documentation of those
 * methods.
 *
 * @param sc       The USpoofChecker
 * @param checks         The set of checks that this spoof checker will perform.
 *                 The value is a bit set, obtained by OR-ing together
 *                 values from enum USpoofChecks.
 * @param status   The error code, set if this function encounters a problem.
 * @stable ICU 4.2
 *
 */
U_CAPI void U_EXPORT2
uspoof_setChecks(USpoofChecker *sc, int32_t checks, UErrorCode *status);

/**
 * Get the set of checks that this Spoof Checker has been configured to perform.
 *
 * @param sc       The USpoofChecker
 * @param status   The error code, set if this function encounters a problem.
 * @return         The set of checks that this spoof checker will perform.
 *                 The value is a bit set, obtained by OR-ing together
 *                 values from enum USpoofChecks.
 * @stable ICU 4.2
 *
 */
U_CAPI int32_t U_EXPORT2
uspoof_getChecks(const USpoofChecker *sc, UErrorCode *status);

/**
 * Set the loosest restriction level allowed for strings. The default if this is not called is
 * {@link USPOOF_HIGHLY_RESTRICTIVE}. Calling this method enables the {@link USPOOF_RESTRICTION_LEVEL} and
 * {@link USPOOF_MIXED_NUMBERS} checks, corresponding to Sections 5.1 and 5.2 of UTS 39. To customize which checks are
 * to be performed by {@link uspoof_check}, see {@link uspoof_setChecks}.
 *
 * @param sc       The USpoofChecker
 * @param restrictionLevel The loosest restriction level allowed.
 * @see URestrictionLevel
 * @stable ICU 51
 */
U_CAPI void U_EXPORT2
uspoof_setRestrictionLevel(USpoofChecker *sc, URestrictionLevel restrictionLevel);


/**
  * Get the Restriction Level that will be tested if the checks include {@link USPOOF_RESTRICTION_LEVEL}.
  *
  * @return The restriction level
  * @see URestrictionLevel
  * @stable ICU 51
  */
U_CAPI URestrictionLevel U_EXPORT2
uspoof_getRestrictionLevel(const USpoofChecker *sc);

/**
 * Limit characters that are acceptable in identifiers being checked to those
 * normally used with the languages associated with the specified locales.
 * Any previously specified list of locales is replaced by the new settings.
 *
 * A set of languages is determined from the locale(s), and
 * from those a set of acceptable Unicode scripts is determined.
 * Characters from this set of scripts, along with characters from
 * the "common" and "inherited" Unicode Script categories
 * will be permitted.
 *
 * Supplying an empty string removes all restrictions;
 * characters from any script will be allowed.
 *
 * The {@link USPOOF_CHAR_LIMIT} test is automatically enabled for this
 * USpoofChecker when calling this function with a non-empty list
 * of locales.
 *
 * The Unicode Set of characters that will be allowed is accessible
 * via the uspoof_getAllowedChars() function.  uspoof_setAllowedLocales()
 * will <i>replace</i> any previously applied set of allowed characters.
 *
 * Adjustments, such as additions or deletions of certain classes of characters,
 * can be made to the result of uspoof_setAllowedLocales() by
 * fetching the resulting set with uspoof_getAllowedChars(),
 * manipulating it with the Unicode Set API, then resetting the
 * spoof detectors limits with uspoof_setAllowedChars().
 *
 * @param sc           The USpoofChecker
 * @param localesList  A list list of locales, from which the language
 *                     and associated script are extracted.  The locales
 *                     are comma-separated if there is more than one.
 *                     White space may not appear within an individual locale,
 *                     but is ignored otherwise.
 *                     The locales are syntactically like those from the
 *                     HTTP Accept-Language header.
 *                     If the localesList is empty, no restrictions will be placed on
 *                     the allowed characters.
 *
 * @param status       The error code, set if this function encounters a problem.
 * @stable ICU 4.2
 */
U_CAPI void U_EXPORT2
uspoof_setAllowedLocales(USpoofChecker *sc, const char *localesList, UErrorCode *status);

/**
 * Get a list of locales for the scripts that are acceptable in strings
 *  to be checked.  If no limitations on scripts have been specified,
 *  an empty string will be returned.
 *
 *  uspoof_setAllowedChars() will reset the list of allowed to be empty.
 *
 *  The format of the returned list is the same as that supplied to
 *  uspoof_setAllowedLocales(), but returned list may not be identical
 *  to the originally specified string; the string may be reformatted,
 *  and information other than languages from
 *  the originally specified locales may be omitted.
 *
 * @param sc           The USpoofChecker
 * @param status       The error code, set if this function encounters a problem.
 * @return             A string containing a list of  locales corresponding
 *                     to the acceptable scripts, formatted like an
 *                     HTTP Accept Language value.
 *
 * @stable ICU 4.2
 */
U_CAPI const char * U_EXPORT2
uspoof_getAllowedLocales(USpoofChecker *sc, UErrorCode *status);


/**
 * Limit the acceptable characters to those specified by a Unicode Set.
 *   Any previously specified character limit is
 *   is replaced by the new settings.  This includes limits on
 *   characters that were set with the uspoof_setAllowedLocales() function.
 *
 * The USPOOF_CHAR_LIMIT test is automatically enabled for this
 * USpoofChecker by this function.
 *
 * @param sc       The USpoofChecker
 * @param chars    A Unicode Set containing the list of
 *                 characters that are permitted.  Ownership of the set
 *                 remains with the caller.  The incoming set is cloned by
 *                 this function, so there are no restrictions on modifying
 *                 or deleting the USet after calling this function.
 * @param status   The error code, set if this function encounters a problem.
 * @stable ICU 4.2
 */
U_CAPI void U_EXPORT2
uspoof_setAllowedChars(USpoofChecker *sc, const USet *chars, UErrorCode *status);


/**
 * Get a USet for the characters permitted in an identifier.
 * This corresponds to the limits imposed by the Set Allowed Characters
 * functions. Limitations imposed by other checks will not be
 * reflected in the set returned by this function.
 *
 * The returned set will be frozen, meaning that it cannot be modified
 * by the caller.
 *
 * Ownership of the returned set remains with the Spoof Detector.  The
 * returned set will become invalid if the spoof detector is closed,
 * or if a new set of allowed characters is specified.
 *
 *
 * @param sc       The USpoofChecker
 * @param status   The error code, set if this function encounters a problem.
 * @return         A USet containing the characters that are permitted by
 *                 the USPOOF_CHAR_LIMIT test.
 * @stable ICU 4.2
 */
U_CAPI const USet * U_EXPORT2
uspoof_getAllowedChars(const USpoofChecker *sc, UErrorCode *status);


/**
 * Check the specified string for possible security issues.
 * The text to be checked will typically be an identifier of some sort.
 * The set of checks to be performed is specified with uspoof_setChecks().
 *
 * \note
 *   Consider using the newer API, {@link uspoof_check2}, instead.
 *   The newer API exposes additional information from the check procedure
 *   and is otherwise identical to this method.
 *
 * @param sc      The USpoofChecker
 * @param id      The identifier to be checked for possible security issues,
 *                in UTF-16 format.
 * @param length  the length of the string to be checked, expressed in
 *                16 bit UTF-16 code units, or -1 if the string is
 *                zero terminated.
 * @param position  Deprecated in ICU 51.  Always returns zero.
 *                Originally, an out parameter for the index of the first
 *                string position that failed a check.
 *                This parameter may be NULL.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Spoofing or security issues detected with the input string are
 *                not reported here, but through the function's return value.
 * @return        An integer value with bits set for any potential security
 *                or spoofing issues detected.  The bits are defined by
 *                enum USpoofChecks.  (returned_value & USPOOF_ALL_CHECKS)
 *                will be zero if the input string passes all of the
 *                enabled checks.
 * @see uspoof_check2
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uspoof_check(const USpoofChecker *sc,
                         const UChar *id, int32_t length,
                         int32_t *position,
                         UErrorCode *status);


/**
 * Check the specified string for possible security issues.
 * The text to be checked will typically be an identifier of some sort.
 * The set of checks to be performed is specified with uspoof_setChecks().
 *
 * \note
 *   Consider using the newer API, {@link uspoof_check2UTF8}, instead.
 *   The newer API exposes additional information from the check procedure
 *   and is otherwise identical to this method.
 *
 * @param sc      The USpoofChecker
 * @param id      A identifier to be checked for possible security issues, in UTF8 format.
 * @param length  the length of the string to be checked, or -1 if the string is
 *                zero terminated.
 * @param position  Deprecated in ICU 51.  Always returns zero.
 *                Originally, an out parameter for the index of the first
 *                string position that failed a check.
 *                This parameter may be NULL.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Spoofing or security issues detected with the input string are
 *                not reported here, but through the function's return value.
 *                If the input contains invalid UTF-8 sequences,
 *                a status of U_INVALID_CHAR_FOUND will be returned.
 * @return        An integer value with bits set for any potential security
 *                or spoofing issues detected.  The bits are defined by
 *                enum USpoofChecks.  (returned_value & USPOOF_ALL_CHECKS)
 *                will be zero if the input string passes all of the
 *                enabled checks.
 * @see uspoof_check2UTF8
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uspoof_checkUTF8(const USpoofChecker *sc,
                 const char *id, int32_t length,
                 int32_t *position,
                 UErrorCode *status);


/**
 * Check the specified string for possible security issues.
 * The text to be checked will typically be an identifier of some sort.
 * The set of checks to be performed is specified with uspoof_setChecks().
 *
 * @param sc      The USpoofChecker
 * @param id      The identifier to be checked for possible security issues,
 *                in UTF-16 format.
 * @param length  the length of the string to be checked, or -1 if the string is
 *                zero terminated.
 * @param checkResult  An instance of USpoofCheckResult to be filled with
 *                details about the identifier.  Can be NULL.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Spoofing or security issues detected with the input string are
 *                not reported here, but through the function's return value.
 * @return        An integer value with bits set for any potential security
 *                or spoofing issues detected.  The bits are defined by
 *                enum USpoofChecks.  (returned_value & USPOOF_ALL_CHECKS)
 *                will be zero if the input string passes all of the
 *                enabled checks.  Any information in this bitmask will be
 *                consistent with the information saved in the optional
 *                checkResult parameter.
 * @see uspoof_openCheckResult
 * @see uspoof_check2UTF8
 * @see uspoof_check2UnicodeString
 * @stable ICU 58
 */
U_CAPI int32_t U_EXPORT2
uspoof_check2(const USpoofChecker *sc,
    const UChar* id, int32_t length,
    USpoofCheckResult* checkResult,
    UErrorCode *status);

/**
 * Check the specified string for possible security issues.
 * The text to be checked will typically be an identifier of some sort.
 * The set of checks to be performed is specified with uspoof_setChecks().
 *
 * This version of {@link uspoof_check} accepts a USpoofCheckResult, which
 * returns additional information about the identifier.  For more
 * information, see {@link uspoof_openCheckResult}.
 *
 * @param sc      The USpoofChecker
 * @param id      A identifier to be checked for possible security issues, in UTF8 format.
 * @param length  the length of the string to be checked, or -1 if the string is
 *                zero terminated.
 * @param checkResult  An instance of USpoofCheckResult to be filled with
 *                details about the identifier.  Can be NULL.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Spoofing or security issues detected with the input string are
 *                not reported here, but through the function's return value.
 * @return        An integer value with bits set for any potential security
 *                or spoofing issues detected.  The bits are defined by
 *                enum USpoofChecks.  (returned_value & USPOOF_ALL_CHECKS)
 *                will be zero if the input string passes all of the
 *                enabled checks.  Any information in this bitmask will be
 *                consistent with the information saved in the optional
 *                checkResult parameter.
 * @see uspoof_openCheckResult
 * @see uspoof_check2
 * @see uspoof_check2UnicodeString
 * @stable ICU 58
 */
U_CAPI int32_t U_EXPORT2
uspoof_check2UTF8(const USpoofChecker *sc,
    const char *id, int32_t length,
    USpoofCheckResult* checkResult,
    UErrorCode *status);

/**
 * Create a USpoofCheckResult, used by the {@link uspoof_check2} class of functions to return
 * information about the identifier.  Information includes:
 * <ul>
 *   <li>A bitmask of the checks that failed</li>
 *   <li>The identifier's restriction level (UTS 39 section 5.2)</li>
 *   <li>The set of numerics in the string (UTS 39 section 5.3)</li>
 * </ul>
 * The data held in a USpoofCheckResult is cleared whenever it is passed into a new call
 * of {@link uspoof_check2}.
 *
 * @param status  The error code, set if this function encounters a problem.
 * @return        the newly created USpoofCheckResult
 * @see uspoof_check2
 * @see uspoof_check2UTF8
 * @see uspoof_check2UnicodeString
 * @stable ICU 58
 */
U_CAPI USpoofCheckResult* U_EXPORT2
uspoof_openCheckResult(UErrorCode *status);

/**
 * Close a USpoofCheckResult, freeing any memory that was being held by
 *   its implementation.
 *
 * @param checkResult  The instance of USpoofCheckResult to close
 * @stable ICU 58
 */
U_CAPI void U_EXPORT2
uspoof_closeCheckResult(USpoofCheckResult *checkResult);

/**
 * Indicates which of the spoof check(s) have failed. The value is a bitwise OR of the constants for the tests
 * in question: USPOOF_RESTRICTION_LEVEL, USPOOF_CHAR_LIMIT, and so on.
 *
 * @param checkResult  The instance of USpoofCheckResult created by {@link uspoof_openCheckResult}
 * @param status       The error code, set if an error occurred.
 * @return        An integer value with bits set for any potential security
 *                or spoofing issues detected.  The bits are defined by
 *                enum USpoofChecks.  (returned_value & USPOOF_ALL_CHECKS)
 *                will be zero if the input string passes all of the
 *                enabled checks.
 * @see uspoof_setChecks
 * @stable ICU 58
 */
U_CAPI int32_t U_EXPORT2
uspoof_getCheckResultChecks(const USpoofCheckResult *checkResult, UErrorCode *status);

/**
 * Gets the restriction level that the text meets, if the USPOOF_RESTRICTION_LEVEL check
 * was enabled; otherwise, undefined.
 *
 * @param checkResult  The instance of USpoofCheckResult created by {@link uspoof_openCheckResult}
 * @param status       The error code, set if an error occurred.
 * @return             The restriction level contained in the USpoofCheckResult
 * @see uspoof_setRestrictionLevel
 * @stable ICU 58
 */
U_CAPI URestrictionLevel U_EXPORT2
uspoof_getCheckResultRestrictionLevel(const USpoofCheckResult *checkResult, UErrorCode *status);

/**
 * Gets the set of numerics found in the string, if the USPOOF_MIXED_NUMBERS check was enabled;
 * otherwise, undefined.  The set will contain the zero digit from each decimal number system found
 * in the input string.  Ownership of the returned USet remains with the USpoofCheckResult.
 * The USet will be free'd when {@link uspoof_closeCheckResult} is called.
 *
 * @param checkResult  The instance of USpoofCheckResult created by {@link uspoof_openCheckResult}
 * @return             The set of numerics contained in the USpoofCheckResult
 * @param status       The error code, set if an error occurred.
 * @stable ICU 58
 */
U_CAPI const USet* U_EXPORT2
uspoof_getCheckResultNumerics(const USpoofCheckResult *checkResult, UErrorCode *status);


/**
 * Check whether two specified strings are visually confusable.
 *
 * If the strings are confusable, the return value will be nonzero, as long as
 * {@link USPOOF_CONFUSABLE} was enabled in uspoof_setChecks().
 *
 * The bits in the return value correspond to flags for each of the classes of
 * confusables applicable to the two input strings.  According to UTS 39
 * section 4, the possible flags are:
 *
 * <ul>
 *   <li>{@link USPOOF_SINGLE_SCRIPT_CONFUSABLE}</li>
 *   <li>{@link USPOOF_MIXED_SCRIPT_CONFUSABLE}</li>
 *   <li>{@link USPOOF_WHOLE_SCRIPT_CONFUSABLE}</li>
 * </ul>
 *
 * If one or more of the above flags were not listed in uspoof_setChecks(), this
 * function will never report that class of confusable.  The check
 * {@link USPOOF_CONFUSABLE} enables all three flags.
 *
 *
 * @param sc      The USpoofChecker
 * @param id1     The first of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-16 format.
 * @param length1 the length of the first identifier, expressed in
 *                16 bit UTF-16 code units, or -1 if the string is
 *                nul terminated.
 * @param id2     The second of the two identifiers to be compared for
 *                confusability.  The identifiers are in UTF-16 format.
 * @param length2 The length of the second identifiers, expressed in
 *                16 bit UTF-16 code units, or -1 if the string is
 *                nul terminated.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Confusability of the identifiers is not reported here,
 *                but through this function's return value.
 * @return        An integer value with bit(s) set corresponding to
 *                the type of confusability found, as defined by
 *                enum USpoofChecks.  Zero is returned if the identifiers
 *                are not confusable.
 *
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uspoof_areConfusable(const USpoofChecker *sc,
                     const UChar *id1, int32_t length1,
                     const UChar *id2, int32_t length2,
                     UErrorCode *status);

/**
 * Check whether two specified strings are visually confusable when
 * displayed in a context with the given paragraph direction.
 *
 * If the strings are confusable, the return value will be nonzero, as long as
 * {@link USPOOF_CONFUSABLE} was enabled in uspoof_setChecks().
 *
 * The bits in the return value correspond to flags for each of the classes of
 * confusables applicable to the two input strings.  According to UTS 39
 * section 4, the possible flags are:
 *
 * <ul>
 *   <li>{@link USPOOF_SINGLE_SCRIPT_CONFUSABLE}</li>
 *   <li>{@link USPOOF_MIXED_SCRIPT_CONFUSABLE}</li>
 *   <li>{@link USPOOF_WHOLE_SCRIPT_CONFUSABLE}</li>
 * </ul>
 *
 * If one or more of the above flags were not listed in uspoof_setChecks(), this
 * function will never report that class of confusable.  The check
 * {@link USPOOF_CONFUSABLE} enables all three flags.
 *
 *
 * @param sc      The USpoofChecker
 * @param direction The paragraph direction with which the identifiers are
 *                displayed.  Must be either UBIDI_LTR or UBIDI_RTL.
 * @param id1     The first of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-16 format.
 * @param length1 the length of the first identifier, expressed in
 *                16 bit UTF-16 code units, or -1 if the string is
 *                nul terminated.
 * @param id2     The second of the two identifiers to be compared for
 *                confusability.  The identifiers are in UTF-16 format.
 * @param length2 The length of the second identifiers, expressed in
 *                16 bit UTF-16 code units, or -1 if the string is
 *                nul terminated.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Confusability of the identifiers is not reported here,
 *                but through this function's return value.
 * @return        An integer value with bit(s) set corresponding to
 *                the type of confusability found, as defined by
 *                enum USpoofChecks.  Zero is returned if the identifiers
 *                are not confusable.
 *
 * @stable ICU 74
 */
U_CAPI uint32_t U_EXPORT2 uspoof_areBidiConfusable(const USpoofChecker *sc, UBiDiDirection direction,
                                                  const UChar *id1, int32_t length1,
                                                  const UChar *id2, int32_t length2,
                                                  UErrorCode *status);

/**
 * A version of {@link uspoof_areConfusable} accepting strings in UTF-8 format.
 *
 * @param sc      The USpoofChecker
 * @param id1     The first of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param length1 the length of the first identifiers, in bytes, or -1
 *                if the string is nul terminated.
 * @param id2     The second of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param length2 The length of the second string in bytes, or -1
 *                if the string is nul terminated.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Confusability of the strings is not reported here,
 *                but through this function's return value.
 * @return        An integer value with bit(s) set corresponding to
 *                the type of confusability found, as defined by
 *                enum USpoofChecks.  Zero is returned if the strings
 *                are not confusable.
 *
 * @stable ICU 4.2
 *
 * @see uspoof_areConfusable
 */
U_CAPI int32_t U_EXPORT2
uspoof_areConfusableUTF8(const USpoofChecker *sc,
                         const char *id1, int32_t length1,
                         const char *id2, int32_t length2,
                         UErrorCode *status);

/**
 * A version of {@link uspoof_areBidiConfusable} accepting strings in UTF-8 format.
 *
 * @param sc      The USpoofChecker
 * @param direction The paragraph direction with which the identifiers are
 *                displayed.  Must be either UBIDI_LTR or UBIDI_RTL.
 * @param id1     The first of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param length1 the length of the first identifiers, in bytes, or -1
 *                if the string is nul terminated.
 * @param id2     The second of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param length2 The length of the second string in bytes, or -1
 *                if the string is nul terminated.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Confusability of the strings is not reported here,
 *                but through this function's return value.
 * @return        An integer value with bit(s) set corresponding to
 *                the type of confusability found, as defined by
 *                enum USpoofChecks.  Zero is returned if the strings
 *                are not confusable.
 *
 * @stable ICU 74
 *
 * @see uspoof_areBidiConfusable
 */
U_CAPI uint32_t U_EXPORT2 uspoof_areBidiConfusableUTF8(const USpoofChecker *sc, UBiDiDirection direction,
                                                      const char *id1, int32_t length1,
                                                      const char *id2, int32_t length2,
                                                      UErrorCode *status);

/**
 *  Get the "skeleton" for an identifier.
 *  Skeletons are a transformation of the input identifier;
 * Two identifiers are confusable if their skeletons are identical.
 *  See Unicode Technical Standard #39 for additional information.
 *
 *  Using skeletons directly makes it possible to quickly check
 *  whether an identifier is confusable with any of some large
 *  set of existing identifiers, by creating an efficiently
 *  searchable collection of the skeletons.
 *
 * @param sc      The USpoofChecker
 * @param type    Deprecated in ICU 58.  You may pass any number.
 *                Originally, controlled which of the Unicode confusable data
 *                tables to use.
 * @param id      The input identifier whose skeleton will be computed.
 * @param length  The length of the input identifier, expressed in 16 bit
 *                UTF-16 code units, or -1 if the string is zero terminated.
 * @param dest    The output buffer, to receive the skeleton string.
 * @param destCapacity  The length of the output buffer, in 16 bit units.
 *                The destCapacity may be zero, in which case the function will
 *                return the actual length of the skeleton.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 * @return        The length of the skeleton string.  The returned length
 *                is always that of the complete skeleton, even when the
 *                supplied buffer is too small (or of zero length)
 *
 * @stable ICU 4.2
 * @see uspoof_areConfusable
 */
U_CAPI int32_t U_EXPORT2
uspoof_getSkeleton(const USpoofChecker *sc,
                   uint32_t type,
                   const UChar *id,  int32_t length,
                   UChar *dest, int32_t destCapacity,
                   UErrorCode *status);

/**
 *  Get the "bidiSkeleton" for an identifier and a direction.
 *  Skeletons are a transformation of the input identifier;
 *  Two identifiers are LTR-confusable if their LTR bidiSkeletons are identical;
 *  they are RTL-confusable if their RTL bidiSkeletons are identical.
 *  See Unicode Technical Standard #39 for additional information:
 *  https://www.unicode.org/reports/tr39/#Confusable_Detection.
 *
 *  Using skeletons directly makes it possible to quickly check
 *  whether an identifier is confusable with any of some large
 *  set of existing identifiers, by creating an efficiently
 *  searchable collection of the skeletons.
 *
 * @param sc      The USpoofChecker.
 * @param direction The context direction with which the identifier will be
 *                displayed.  Must be either UBIDI_LTR or UBIDI_RTL.
 * @param id      The input identifier whose skeleton will be computed.
 * @param length  The length of the input identifier, expressed in 16 bit
 *                UTF-16 code units, or -1 if the string is zero terminated.
 * @param dest    The output buffer, to receive the skeleton string.
 * @param destCapacity  The length of the output buffer, in 16 bit units.
 *                The destCapacity may be zero, in which case the function will
 *                return the actual length of the skeleton.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 * @return        The length of the skeleton string.  The returned length
 *                is always that of the complete skeleton, even when the
 *                supplied buffer is too small (or of zero length)
 *
 * @stable ICU 74
 * @see uspoof_areBidiConfusable
 */
U_CAPI int32_t U_EXPORT2 uspoof_getBidiSkeleton(const USpoofChecker *sc,
                                                UBiDiDirection direction,
                                                const UChar *id, int32_t length,
                                                UChar *dest, int32_t destCapacity, UErrorCode *status);

/**
 *  Get the "skeleton" for an identifier.
 *  Skeletons are a transformation of the input identifier;
 *  Two identifiers are confusable if their skeletons are identical.
 *  See Unicode Technical Standard #39 for additional information.
 *
 *  Using skeletons directly makes it possible to quickly check
 *  whether an identifier is confusable with any of some large
 *  set of existing identifiers, by creating an efficiently
 *  searchable collection of the skeletons.
 *
 * @param sc      The USpoofChecker
 * @param type    Deprecated in ICU 58.  You may pass any number.
 *                Originally, controlled which of the Unicode confusable data
 *                tables to use.
 * @param id      The UTF-8 format identifier whose skeleton will be computed.
 * @param length  The length of the input string, in bytes,
 *                or -1 if the string is zero terminated.
 * @param dest    The output buffer, to receive the skeleton string.
 * @param destCapacity  The length of the output buffer, in bytes.
 *                The destCapacity may be zero, in which case the function will
 *                return the actual length of the skeleton.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.  Possible Errors include U_INVALID_CHAR_FOUND
 *                   for invalid UTF-8 sequences, and
 *                   U_BUFFER_OVERFLOW_ERROR if the destination buffer is too small
 *                   to hold the complete skeleton.
 * @return        The length of the skeleton string, in bytes.  The returned length
 *                is always that of the complete skeleton, even when the
 *                supplied buffer is too small (or of zero length)
 *
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uspoof_getSkeletonUTF8(const USpoofChecker *sc,
                       uint32_t type,
                       const char *id,  int32_t length,
                       char *dest, int32_t destCapacity,
                       UErrorCode *status);

/**
 *  Get the "bidiSkeleton" for an identifier and a direction.
 *  Skeletons are a transformation of the input identifier;
 *  Two identifiers are LTR-confusable if their LTR bidiSkeletons are identical;
 *  they are RTL-confusable if their RTL bidiSkeletons are identical.
 *  See Unicode Technical Standard #39 for additional information:
 *  https://www.unicode.org/reports/tr39/#Confusable_Detection.
 *
 *  Using skeletons directly makes it possible to quickly check
 *  whether an identifier is confusable with any of some large
 *  set of existing identifiers, by creating an efficiently
 *  searchable collection of the skeletons.
 *
 * @param sc      The USpoofChecker
 * @param direction The context direction with which the identifier will be
 *                displayed.  Must be either UBIDI_LTR or UBIDI_RTL.
 * @param id      The UTF-8 format identifier whose skeleton will be computed.
 * @param length  The length of the input string, in bytes,
 *                or -1 if the string is zero terminated.
 * @param dest    The output buffer, to receive the skeleton string.
 * @param destCapacity  The length of the output buffer, in bytes.
 *                The destCapacity may be zero, in which case the function will
 *                return the actual length of the skeleton.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.  Possible Errors include U_INVALID_CHAR_FOUND
 *                for invalid UTF-8 sequences, and
 *                U_BUFFER_OVERFLOW_ERROR if the destination buffer is too small
 *                to hold the complete skeleton.
 * @return        The length of the skeleton string, in bytes.  The returned length
 *                is always that of the complete skeleton, even when the
 *                supplied buffer is too small (or of zero length)
 *
 * @stable ICU 74
 */
U_CAPI int32_t U_EXPORT2 uspoof_getBidiSkeletonUTF8(const USpoofChecker *sc, UBiDiDirection direction,
                                                    const char *id, int32_t length, char *dest,
                                                    int32_t destCapacity, UErrorCode *status);

/**
  * Get the set of Candidate Characters for Inclusion in Identifiers, as defined
  * in http://unicode.org/Public/security/latest/xidmodifications.txt
  * and documented in http://www.unicode.org/reports/tr39/, Unicode Security Mechanisms.
  *
  * The returned set is frozen. Ownership of the set remains with the ICU library; it must not
  * be deleted by the caller.
  *
  * @param status The error code, set if a problem occurs while creating the set.
  *
  * @stable ICU 51
  */
U_CAPI const USet * U_EXPORT2
uspoof_getInclusionSet(UErrorCode *status);

/**
  * Get the set of characters from Recommended Scripts for Inclusion in Identifiers, as defined
  * in http://unicode.org/Public/security/latest/xidmodifications.txt
  * and documented in http://www.unicode.org/reports/tr39/, Unicode Security Mechanisms.
  *
  * The returned set is frozen. Ownership of the set remains with the ICU library; it must not
  * be deleted by the caller.
  *
  * @param status The error code, set if a problem occurs while creating the set.
  *
  * @stable ICU 51
  */
U_CAPI const USet * U_EXPORT2
uspoof_getRecommendedSet(UErrorCode *status);

/**
 * Serialize the data for a spoof detector into a chunk of memory.
 * The flattened spoof detection tables can later be used to efficiently
 * instantiate a new Spoof Detector.
 *
 * The serialized spoof checker includes only the data compiled from the
 * Unicode data tables by uspoof_openFromSource(); it does not include
 * include any other state or configuration that may have been set.
 *
 * @param sc   the Spoof Detector whose data is to be serialized.
 * @param data a pointer to 32-bit-aligned memory to be filled with the data,
 *             can be NULL if capacity==0
 * @param capacity the number of bytes available at data,
 *                 or 0 for preflighting
 * @param status an in/out ICU UErrorCode; possible errors include:
 * - U_BUFFER_OVERFLOW_ERROR if the data storage block is too small for serialization
 * - U_ILLEGAL_ARGUMENT_ERROR  the data or capacity parameters are bad
 * @return the number of bytes written or needed for the spoof data
 *
 * @see utrie2_openFromSerialized()
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uspoof_serialize(USpoofChecker *sc,
                 void *data, int32_t capacity,
                 UErrorCode *status);

U_CDECL_END

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUSpoofCheckerPointer
 * "Smart pointer" class, closes a USpoofChecker via uspoof_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
/**
 * \cond
 * Note: Doxygen is giving a bogus warning on this U_DEFINE_LOCAL_OPEN_POINTER.
 *       For now, suppress with a Doxygen cond
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUSpoofCheckerPointer, USpoofChecker, uspoof_close);
/** \endcond */

/**
 * \class LocalUSpoofCheckResultPointer
 * "Smart pointer" class, closes a USpoofCheckResult via `uspoof_closeCheckResult()`.
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 58
 */

/**
 * \cond
 * Note: Doxygen is giving a bogus warning on this U_DEFINE_LOCAL_OPEN_POINTER.
 *       For now, suppress with a Doxygen cond
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUSpoofCheckResultPointer, USpoofCheckResult, uspoof_closeCheckResult);
/** \endcond */

U_NAMESPACE_END

/**
 * Limit the acceptable characters to those specified by a Unicode Set.
 *   Any previously specified character limit is
 *   is replaced by the new settings.    This includes limits on
 *   characters that were set with the uspoof_setAllowedLocales() function.
 *
 * The USPOOF_CHAR_LIMIT test is automatically enabled for this
 * USoofChecker by this function.
 *
 * @param sc       The USpoofChecker
 * @param chars    A Unicode Set containing the list of
 *                 characters that are permitted.  Ownership of the set
 *                 remains with the caller.  The incoming set is cloned by
 *                 this function, so there are no restrictions on modifying
 *                 or deleting the UnicodeSet after calling this function.
 * @param status   The error code, set if this function encounters a problem.
 * @stable ICU 4.2
 */
U_CAPI void U_EXPORT2
uspoof_setAllowedUnicodeSet(USpoofChecker *sc, const icu::UnicodeSet *chars, UErrorCode *status);


/**
 * Get a UnicodeSet for the characters permitted in an identifier.
 * This corresponds to the limits imposed by the Set Allowed Characters /
 * UnicodeSet functions. Limitations imposed by other checks will not be
 * reflected in the set returned by this function.
 *
 * The returned set will be frozen, meaning that it cannot be modified
 * by the caller.
 *
 * Ownership of the returned set remains with the Spoof Detector.  The
 * returned set will become invalid if the spoof detector is closed,
 * or if a new set of allowed characters is specified.
 *
 *
 * @param sc       The USpoofChecker
 * @param status   The error code, set if this function encounters a problem.
 * @return         A UnicodeSet containing the characters that are permitted by
 *                 the USPOOF_CHAR_LIMIT test.
 * @stable ICU 4.2
 */
U_CAPI const icu::UnicodeSet * U_EXPORT2
uspoof_getAllowedUnicodeSet(const USpoofChecker *sc, UErrorCode *status);

/**
 * Check the specified string for possible security issues.
 * The text to be checked will typically be an identifier of some sort.
 * The set of checks to be performed is specified with uspoof_setChecks().
 *
 * \note
 *   Consider using the newer API, {@link uspoof_check2UnicodeString}, instead.
 *   The newer API exposes additional information from the check procedure
 *   and is otherwise identical to this method.
 *
 * @param sc      The USpoofChecker
 * @param id      A identifier to be checked for possible security issues.
 * @param position  Deprecated in ICU 51.  Always returns zero.
 *                Originally, an out parameter for the index of the first
 *                string position that failed a check.
 *                This parameter may be nullptr.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Spoofing or security issues detected with the input string are
 *                not reported here, but through the function's return value.
 * @return        An integer value with bits set for any potential security
 *                or spoofing issues detected.  The bits are defined by
 *                enum USpoofChecks.  (returned_value & USPOOF_ALL_CHECKS)
 *                will be zero if the input string passes all of the
 *                enabled checks.
 * @see uspoof_check2UnicodeString
 * @stable ICU 4.2
 */
U_CAPI int32_t U_EXPORT2
uspoof_checkUnicodeString(const USpoofChecker *sc,
                          const icu::UnicodeString &id,
                          int32_t *position,
                          UErrorCode *status);

/**
 * Check the specified string for possible security issues.
 * The text to be checked will typically be an identifier of some sort.
 * The set of checks to be performed is specified with uspoof_setChecks().
 *
 * @param sc      The USpoofChecker
 * @param id      A identifier to be checked for possible security issues.
 * @param checkResult  An instance of USpoofCheckResult to be filled with
 *                details about the identifier.  Can be nullptr.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Spoofing or security issues detected with the input string are
 *                not reported here, but through the function's return value.
 * @return        An integer value with bits set for any potential security
 *                or spoofing issues detected.  The bits are defined by
 *                enum USpoofChecks.  (returned_value & USPOOF_ALL_CHECKS)
 *                will be zero if the input string passes all of the
 *                enabled checks.  Any information in this bitmask will be
 *                consistent with the information saved in the optional
 *                checkResult parameter.
 * @see uspoof_openCheckResult
 * @see uspoof_check2
 * @see uspoof_check2UTF8
 * @stable ICU 58
 */
U_CAPI int32_t U_EXPORT2
uspoof_check2UnicodeString(const USpoofChecker *sc,
    const icu::UnicodeString &id,
    USpoofCheckResult* checkResult,
    UErrorCode *status);

/**
 * A version of {@link uspoof_areConfusable} accepting UnicodeStrings.
 *
 * @param sc      The USpoofChecker
 * @param s1     The first of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param s2     The second of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Confusability of the identifiers is not reported here,
 *                but through this function's return value.
 * @return        An integer value with bit(s) set corresponding to
 *                the type of confusability found, as defined by
 *                enum USpoofChecks.  Zero is returned if the identifiers
 *                are not confusable.
 *
 * @stable ICU 4.2
 *
 * @see uspoof_areConfusable
 */
U_CAPI int32_t U_EXPORT2
uspoof_areConfusableUnicodeString(const USpoofChecker *sc,
                                  const icu::UnicodeString &s1,
                                  const icu::UnicodeString &s2,
                                  UErrorCode *status);

/**
 * A version of {@link uspoof_areBidiConfusable} accepting UnicodeStrings.
 *
 * @param sc      The USpoofChecker
 * @param direction The paragraph direction with which the identifiers are
 *                displayed.  Must be either UBIDI_LTR or UBIDI_RTL.
 * @param s1     The first of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param s2     The second of the two identifiers to be compared for
 *                confusability.  The strings are in UTF-8 format.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 *                Confusability of the identifiers is not reported here,
 *                but through this function's return value.
 * @return        An integer value with bit(s) set corresponding to
 *                the type of confusability found, as defined by
 *                enum USpoofChecks.  Zero is returned if the identifiers
 *                are not confusable.
 *
 * @stable ICU 74
 *
 * @see uspoof_areBidiConfusable
 */
U_CAPI uint32_t U_EXPORT2 uspoof_areBidiConfusableUnicodeString(const USpoofChecker *sc,
                                                               UBiDiDirection direction,
                                                               const icu::UnicodeString &s1,
                                                               const icu::UnicodeString &s2,
                                                               UErrorCode *status);

/**
 *  Get the "skeleton" for an identifier.
 *  Skeletons are a transformation of the input identifier;
 *  Two identifiers are confusable if their skeletons are identical.
 *  See Unicode Technical Standard #39 for additional information.
 *
 *  Using skeletons directly makes it possible to quickly check
 *  whether an identifier is confusable with any of some large
 *  set of existing identifiers, by creating an efficiently
 *  searchable collection of the skeletons.
 *
 * @param sc      The USpoofChecker.
 * @param type    Deprecated in ICU 58.  You may pass any number.
 *                Originally, controlled which of the Unicode confusable data
 *                tables to use.
 * @param id      The input identifier whose skeleton will be computed.
 * @param dest    The output identifier, to receive the skeleton string.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 * @return        A reference to the destination (skeleton) string.
 *
 * @stable ICU 4.2
 */
U_I18N_API icu::UnicodeString & U_EXPORT2
uspoof_getSkeletonUnicodeString(const USpoofChecker *sc,
                                uint32_t type,
                                const icu::UnicodeString &id,
                                icu::UnicodeString &dest,
                                UErrorCode *status);

/**
 *  Get the "bidiSkeleton" for an identifier and a direction.
 *  Skeletons are a transformation of the input identifier;
 *  Two identifiers are LTR-confusable if their LTR bidiSkeletons are identical;
 *  they are RTL-confusable if their RTL bidiSkeletons are identical.
 *  See Unicode Technical Standard #39 for additional information.
 *  https://www.unicode.org/reports/tr39/#Confusable_Detection.
 *
 *  Using skeletons directly makes it possible to quickly check
 *  whether an identifier is confusable with any of some large
 *  set of existing identifiers, by creating an efficiently
 *  searchable collection of the skeletons.
 *
 * @param sc      The USpoofChecker.
 * @param direction The context direction with which the identifier will be
 *                displayed.  Must be either UBIDI_LTR or UBIDI_RTL.
 * @param id      The input identifier whose bidiSkeleton will be computed.
 * @param dest    The output identifier, to receive the skeleton string.
 * @param status  The error code, set if an error occurred while attempting to
 *                perform the check.
 * @return        A reference to the destination (skeleton) string.
 *
 * @stable ICU 74
 */
U_I18N_API icu::UnicodeString &U_EXPORT2 uspoof_getBidiSkeletonUnicodeString(
    const USpoofChecker *sc, UBiDiDirection direction, const icu::UnicodeString &id,
    icu::UnicodeString &dest, UErrorCode *status);

/**
  * Get the set of Candidate Characters for Inclusion in Identifiers, as defined
  * in http://unicode.org/Public/security/latest/xidmodifications.txt
  * and documented in http://www.unicode.org/reports/tr39/, Unicode Security Mechanisms.
  *
  * The returned set is frozen. Ownership of the set remains with the ICU library; it must not
  * be deleted by the caller.
  *
  * @param status The error code, set if a problem occurs while creating the set.
  *
  * @stable ICU 51
  */
U_CAPI const icu::UnicodeSet * U_EXPORT2
uspoof_getInclusionUnicodeSet(UErrorCode *status);

/**
  * Get the set of characters from Recommended Scripts for Inclusion in Identifiers, as defined
  * in http://unicode.org/Public/security/latest/xidmodifications.txt
  * and documented in http://www.unicode.org/reports/tr39/, Unicode Security Mechanisms.
  *
  * The returned set is frozen. Ownership of the set remains with the ICU library; it must not
  * be deleted by the caller.
  *
  * @param status The error code, set if a problem occurs while creating the set.
  *
  * @stable ICU 51
  */
U_CAPI const icu::UnicodeSet * U_EXPORT2
uspoof_getRecommendedUnicodeSet(UErrorCode *status);

#endif /* U_SHOW_CPLUSPLUS_API */

#endif /* UCONFIG_NO_NORMALIZATION */

#endif   /* USPOOF_H */
