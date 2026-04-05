// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 2004-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*   file name:  uregex.h
*   encoding:   UTF-8
*   indentation:4
*
*   created on: 2004mar09
*   created by: Andy Heninger
*
*   ICU Regular Expressions, API for C
*/

/**
 * \file
 * \brief C API: Regular Expressions
 *
 * <p>This is a C wrapper around the C++ RegexPattern and RegexMatcher classes.</p>
 */

#ifndef UREGEX_H
#define UREGEX_H

#include "unicode/utext.h"
#include "unicode/utypes.h"

#if !UCONFIG_NO_REGULAR_EXPRESSIONS

#include "unicode/parseerr.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

struct URegularExpression;
/**
  * Structure representing a compiled regular expression, plus the results
  *    of a match operation.
  * @stable ICU 3.0
  */
typedef struct URegularExpression URegularExpression;


/**
 * Constants for Regular Expression Match Modes.
 * @stable ICU 2.4
 */
typedef enum URegexpFlag{

#ifndef U_HIDE_DRAFT_API 
    /** Forces normalization of pattern and strings. 
    Not implemented yet, just a placeholder, hence draft. 
    @draft ICU 2.4 */
    UREGEX_CANON_EQ         = 128,
#endif /* U_HIDE_DRAFT_API */
    /**  Enable case insensitive matching.  @stable ICU 2.4 */
    UREGEX_CASE_INSENSITIVE = 2,

    /**  Allow white space and comments within patterns  @stable ICU 2.4 */
    UREGEX_COMMENTS         = 4,

    /**  If set, '.' matches line terminators,  otherwise '.' matching stops at line end.
      *  @stable ICU 2.4 */
    UREGEX_DOTALL           = 32,
    
    /**  If set, treat the entire pattern as a literal string.  
      *  Metacharacters or escape sequences in the input sequence will be given 
      *  no special meaning. 
      *
      *  The flag UREGEX_CASE_INSENSITIVE retains its impact
      *  on matching when used in conjunction with this flag.
      *  The other flags become superfluous.
      *
      * @stable ICU 4.0
      */
    UREGEX_LITERAL = 16,

    /**   Control behavior of "$" and "^"
      *    If set, recognize line terminators within string,
      *    otherwise, match only at start and end of input string.
      *   @stable ICU 2.4 */
    UREGEX_MULTILINE        = 8,
    
    /**   Unix-only line endings.
      *   When this mode is enabled, only \\u000a is recognized as a line ending
      *    in the behavior of ., ^, and $.
      *   @stable ICU 4.0
      */
    UREGEX_UNIX_LINES = 1,

    /**  Unicode word boundaries.
      *     If set, \b uses the Unicode TR 29 definition of word boundaries.
      *     Warning: Unicode word boundaries are quite different from
      *     traditional regular expression word boundaries.  See
      *     http://unicode.org/reports/tr29/#Word_Boundaries
      *     @stable ICU 2.8
      */
    UREGEX_UWORD            = 256,

     /**  Error on Unrecognized backslash escapes.
       *     If set, fail with an error on patterns that contain
       *     backslash-escaped ASCII letters without a known special
       *     meaning.  If this flag is not set, these
       *     escaped letters represent themselves.
       *     @stable ICU 4.0
       */
     UREGEX_ERROR_ON_UNKNOWN_ESCAPES = 512

}  URegexpFlag;

/**
  *  Open (compile) an ICU regular expression.  Compiles the regular expression in
  *  string form into an internal representation using the specified match mode flags.
  *  The resulting regular expression handle can then be used to perform various
  *   matching operations.
  * 
  *
  * @param pattern        The Regular Expression pattern to be compiled. 
  * @param patternLength  The length of the pattern, or -1 if the pattern is
  *                       NUL terminated.
  * @param flags          Flags that alter the default matching behavior for
  *                       the regular expression, UREGEX_CASE_INSENSITIVE, for
  *                       example.  For default behavior, set this parameter to zero.
  *                       See <code>enum URegexpFlag</code>.  All desired flags
  *                       are bitwise-ORed together.
  * @param pe             Receives the position (line and column numbers) of any syntax
  *                       error within the source regular expression string.  If this
  *                       information is not wanted, pass NULL for this parameter.
  * @param status         Receives error detected by this function.
  * @stable ICU 3.0
  *
  */
U_CAPI URegularExpression * U_EXPORT2
uregex_open( const  UChar          *pattern,
                    int32_t         patternLength,
                    uint32_t        flags,
                    UParseError    *pe,
                    UErrorCode     *status);

/**
  *  Open (compile) an ICU regular expression.  Compiles the regular expression in
  *  string form into an internal representation using the specified match mode flags.
  *  The resulting regular expression handle can then be used to perform various
  *   matching operations.
  *  <p>
  *  The contents of the pattern UText will be extracted and saved. Ownership of the
  *   UText struct itself remains with the caller. This is to match the behavior of
  *   uregex_open().
  *
  * @param pattern        The Regular Expression pattern to be compiled. 
  * @param flags          Flags that alter the default matching behavior for
  *                       the regular expression, UREGEX_CASE_INSENSITIVE, for
  *                       example.  For default behavior, set this parameter to zero.
  *                       See <code>enum URegexpFlag</code>.  All desired flags
  *                       are bitwise-ORed together.
  * @param pe             Receives the position (line and column numbers) of any syntax
  *                       error within the source regular expression string.  If this
  *                       information is not wanted, pass NULL for this parameter.
  * @param status         Receives error detected by this function.
  *
  * @stable ICU 4.6
  */
U_CAPI URegularExpression *  U_EXPORT2
uregex_openUText(UText          *pattern,
                 uint32_t        flags,
                 UParseError    *pe,
                 UErrorCode     *status);

#if !UCONFIG_NO_CONVERSION
/**
  *  Open (compile) an ICU regular expression.  The resulting regular expression
  *   handle can then be used to perform various matching operations.
  *  <p>
  *   This function is the same as uregex_open, except that the pattern
  *   is supplied as an 8 bit char * string in the default code page.
  *
  * @param pattern        The Regular Expression pattern to be compiled, 
  *                       NUL terminated.  
  * @param flags          Flags that alter the default matching behavior for
  *                       the regular expression, UREGEX_CASE_INSENSITIVE, for
  *                       example.  For default behavior, set this parameter to zero.
  *                       See <code>enum URegexpFlag</code>.  All desired flags
  *                       are bitwise-ORed together.
  * @param pe             Receives the position (line and column numbers) of any syntax
  *                       error within the source regular expression string.  If this
  *                       information is not wanted, pass NULL for this parameter.
  * @param status         Receives errors detected by this function.
  * @return               The URegularExpression object representing the compiled
  *                       pattern.
  *
  * @stable ICU 3.0
  */
U_CAPI URegularExpression * U_EXPORT2
uregex_openC( const char           *pattern,
                    uint32_t        flags,
                    UParseError    *pe,
                    UErrorCode     *status);
#endif



/**
  *  Close the regular expression, recovering all resources (memory) it
  *   was holding.
  *
  * @param regexp   The regular expression to be closed.
  * @stable ICU 3.0
  */
U_CAPI void U_EXPORT2 
uregex_close(URegularExpression *regexp);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalURegularExpressionPointer
 * "Smart pointer" class, closes a URegularExpression via uregex_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalURegularExpressionPointer, URegularExpression, uregex_close);

U_NAMESPACE_END

#endif

/**
 * Make a copy of a compiled regular expression.  Cloning a regular
 * expression is faster than opening a second instance from the source
 * form of the expression, and requires less memory.
 * <p>
 * Note that the current input string and the position of any matched text
 *  within it are not cloned; only the pattern itself and the
 *  match mode flags are copied.
 * <p>
 * Cloning can be particularly useful to threaded applications that perform
 * multiple match operations in parallel.  Each concurrent RE
 * operation requires its own instance of a URegularExpression.
 *
 * @param regexp   The compiled regular expression to be cloned.
 * @param status   Receives indication of any errors encountered
 * @return the cloned copy of the compiled regular expression.
 * @stable ICU 3.0
 */
U_CAPI URegularExpression * U_EXPORT2 
uregex_clone(const URegularExpression *regexp, UErrorCode *status);

/**
 *  Returns a pointer to the source form of the pattern for this regular expression.
 *  This function will work even if the pattern was originally specified as a UText.
 *
 * @param regexp     The compiled regular expression.
 * @param patLength  This output parameter will be set to the length of the
 *                   pattern string.  A NULL pointer may be used here if the
 *                   pattern length is not needed, as would be the case if
 *                   the pattern is known in advance to be a NUL terminated
 *                   string.
 * @param status     Receives errors detected by this function.
 * @return a pointer to the pattern string.  The storage for the string is
 *                   owned by the regular expression object, and must not be
 *                   altered or deleted by the application.  The returned string
 *                   will remain valid until the regular expression is closed.
 * @stable ICU 3.0
 */
U_CAPI const UChar * U_EXPORT2 
uregex_pattern(const URegularExpression *regexp,
                     int32_t            *patLength,
                     UErrorCode         *status);

/**
 *  Returns the source text of the pattern for this regular expression.
 *  This function will work even if the pattern was originally specified as a UChar string.
 *
 * @param regexp     The compiled regular expression.
 * @param status     Receives errors detected by this function.
 * @return the pattern text.  The storage for the text is owned by the regular expression
 *                   object, and must not be altered or deleted.
 *
 * @stable ICU 4.6
 */
U_CAPI UText * U_EXPORT2 
uregex_patternUText(const URegularExpression *regexp,
                          UErrorCode         *status);

/**
  * Get the match mode flags that were specified when compiling this regular expression.
  * @param status   Receives errors detected by this function.
  * @param regexp   The compiled regular expression.
  * @return         The match mode flags
  * @see URegexpFlag
  * @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_flags(const  URegularExpression   *regexp,
                    UErrorCode           *status);


/**
  *  Set the subject text string upon which the regular expression will look for matches.
  *  This function may be called any number of times, allowing the regular
  *  expression pattern to be applied to different strings.
  *  <p>
  *  Regular expression matching operations work directly on the application's
  *  string data.  No copy is made.  The subject string data must not be
  *  altered after calling this function until after all regular expression
  *  operations involving this string data are completed.  
  *  <p>
  *  Zero length strings are permitted.  In this case, no subsequent match
  *  operation will dereference the text string pointer.
  *
  * @param regexp     The compiled regular expression.
  * @param text       The subject text string.
  * @param textLength The length of the subject text, or -1 if the string
  *                   is NUL terminated.
  * @param status     Receives errors detected by this function.
  * @stable ICU 3.0
  */
U_CAPI void U_EXPORT2 
uregex_setText(URegularExpression *regexp,
               const UChar        *text,
               int32_t             textLength,
               UErrorCode         *status);


/**
  *  Set the subject text string upon which the regular expression will look for matches.
  *  This function may be called any number of times, allowing the regular
  *  expression pattern to be applied to different strings.
  *  <p>
  *  Regular expression matching operations work directly on the application's
  *  string data; only a shallow clone is made.  The subject string data must not be
  *  altered after calling this function until after all regular expression
  *  operations involving this string data are completed.  
  *
  * @param regexp     The compiled regular expression.
  * @param text       The subject text string.
  * @param status     Receives errors detected by this function.
  *
  * @stable ICU 4.6
  */
U_CAPI void U_EXPORT2 
uregex_setUText(URegularExpression *regexp,
                UText              *text,
                UErrorCode         *status);

/**
  *  Get the subject text that is currently associated with this 
  *   regular expression object.  If the input was supplied using uregex_setText(),
  *   that pointer will be returned.  Otherwise, the characters in the input will
  *   be extracted to a buffer and returned.  In either case, ownership remains
  *   with the regular expression object.
  *
  *  This function will work even if the input was originally specified as a UText.
  *
  * @param regexp      The compiled regular expression.
  * @param textLength  The length of the string is returned in this output parameter. 
  *                    A NULL pointer may be used here if the
  *                    text length is not needed, as would be the case if
  *                    the text is known in advance to be a NUL terminated
  *                    string.
  * @param status      Receives errors detected by this function.
  * @return            Pointer to the subject text string currently associated with
  *                    this regular expression.
  * @stable ICU 3.0
  */
U_CAPI const UChar * U_EXPORT2 
uregex_getText(URegularExpression *regexp,
               int32_t            *textLength,
               UErrorCode         *status);

/**
  *  Get the subject text that is currently associated with this 
  *   regular expression object.
  *
  *  This function will work even if the input was originally specified as a UChar string.
  *
  * @param regexp      The compiled regular expression.
  * @param dest        A mutable UText in which to store the current input.
  *                    If NULL, a new UText will be created as an immutable shallow clone
  *                    of the actual input string.
  * @param status      Receives errors detected by this function.
  * @return            The subject text currently associated with this regular expression.
  *                    If a pre-allocated UText was provided, it will always be used and returned.
  *
  * @stable ICU 4.6
  */
U_CAPI UText * U_EXPORT2 
uregex_getUText(URegularExpression *regexp,
                UText              *dest,
                UErrorCode         *status);

/**
  *  Set the subject text string upon which the regular expression is looking for matches
  *  without changing any other aspect of the matching state.
  *  The new and previous text strings must have the same content.
  *
  *  This function is intended for use in environments where ICU is operating on 
  *  strings that may move around in memory.  It provides a mechanism for notifying
  *  ICU that the string has been relocated, and providing a new UText to access the
  *  string in its new position.
  *
  *  Note that the regular expression implementation never copies the underlying text
  *  of a string being matched, but always operates directly on the original text 
  *  provided by the user. Refreshing simply drops the references to the old text 
  *  and replaces them with references to the new.
  *
  *  Caution:  this function is normally used only by very specialized
  *            system-level code.   One example use case is with garbage collection 
  *            that moves the text in memory. 
  *
  * @param regexp     The compiled regular expression.
  * @param text       The new (moved) text string.
  * @param status     Receives errors detected by this function.
  *
  * @stable ICU 4.8
  */
U_CAPI void U_EXPORT2 
uregex_refreshUText(URegularExpression *regexp,
                    UText              *text,
                    UErrorCode         *status);

/**
  *   Attempts to match the input string against the pattern.
  *   To succeed, the match must extend to the end of the string,
  *   or cover the complete match region.
  *
  *   If startIndex >= zero the match operation starts at the specified
  *   index and must extend to the end of the input string.  Any region
  *   that has been specified is reset.
  *
  *   If startIndex == -1 the match must cover the input region, or the entire
  *   input string if no region has been set.  This directly corresponds to
  *   Matcher.matches() in Java
  *
  *    @param  regexp      The compiled regular expression.
  *    @param  startIndex  The input string (native) index at which to begin matching, or -1
  *                        to match the input Region.
  *    @param  status      Receives errors detected by this function.
  *    @return             true if there is a match
  *    @stable ICU 3.0
  */
U_CAPI UBool U_EXPORT2 
uregex_matches(URegularExpression *regexp,
                int32_t            startIndex,
                UErrorCode        *status);

/**
  *   64bit version of uregex_matches.
  *   Attempts to match the input string against the pattern.
  *   To succeed, the match must extend to the end of the string,
  *   or cover the complete match region.
  *
  *   If startIndex >= zero the match operation starts at the specified
  *   index and must extend to the end of the input string.  Any region
  *   that has been specified is reset.
  *
  *   If startIndex == -1 the match must cover the input region, or the entire
  *   input string if no region has been set.  This directly corresponds to
  *   Matcher.matches() in Java
  *
  *    @param  regexp      The compiled regular expression.
  *    @param  startIndex  The input string (native) index at which to begin matching, or -1
  *                        to match the input Region.
  *    @param  status      Receives errors detected by this function.
  *    @return             true if there is a match
  *   @stable ICU 4.6
  */
U_CAPI UBool U_EXPORT2 
uregex_matches64(URegularExpression *regexp,
                 int64_t            startIndex,
                 UErrorCode        *status);

/**
  *   Attempts to match the input string, starting from the specified index, against the pattern.
  *   The match may be of any length, and is not required to extend to the end
  *   of the input string.  Contrast with uregex_matches().
  *
  *   <p>If startIndex is >= 0 any input region that was set for this
  *   URegularExpression is reset before the operation begins.
  *
  *   <p>If the specified starting index == -1 the match begins at the start of the input 
  *   region, or at the start of the full string if no region has been specified.
  *   This corresponds directly with Matcher.lookingAt() in Java.
  *
  *   <p>If the match succeeds then more information can be obtained via the
  *    <code>uregexp_start()</code>, <code>uregexp_end()</code>,
  *    and <code>uregex_group()</code> functions.</p>
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   startIndex  The input string (native) index at which to begin matching, or
  *                         -1 to match the Input Region
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @return  true if there is a match.
  *    @stable ICU 3.0
  */
U_CAPI UBool U_EXPORT2 
uregex_lookingAt(URegularExpression *regexp,
                 int32_t             startIndex,
                 UErrorCode         *status);

/**
  *   64bit version of uregex_lookingAt.
  *   Attempts to match the input string, starting from the specified index, against the pattern.
  *   The match may be of any length, and is not required to extend to the end
  *   of the input string.  Contrast with uregex_matches().
  *
  *   <p>If startIndex is >= 0 any input region that was set for this
  *   URegularExpression is reset before the operation begins.
  *
  *   <p>If the specified starting index == -1 the match begins at the start of the input 
  *   region, or at the start of the full string if no region has been specified.
  *   This corresponds directly with Matcher.lookingAt() in Java.
  *
  *   <p>If the match succeeds then more information can be obtained via the
  *    <code>uregexp_start()</code>, <code>uregexp_end()</code>,
  *    and <code>uregex_group()</code> functions.</p>
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   startIndex  The input string (native) index at which to begin matching, or
  *                         -1 to match the Input Region
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @return  true if there is a match.
  *    @stable ICU 4.6
  */
U_CAPI UBool U_EXPORT2 
uregex_lookingAt64(URegularExpression *regexp,
                   int64_t             startIndex,
                   UErrorCode         *status);

/**
  *   Find the first matching substring of the input string that matches the pattern.
  *   If startIndex is >= zero the search for a match begins at the specified index,
  *          and any match region is reset.  This corresponds directly with
  *          Matcher.find(startIndex) in Java.
  *
  *   If startIndex == -1 the search begins at the start of the input region,
  *           or at the start of the full string if no region has been specified.
  *
  *   If a match is found, <code>uregex_start(), uregex_end()</code>, and
  *   <code>uregex_group()</code> will provide more information regarding the match.
  *
  *   @param   regexp      The compiled regular expression.
  *   @param   startIndex  The position (native) in the input string to begin the search, or
  *                        -1 to search within the Input Region.
  *   @param   status      A reference to a UErrorCode to receive any errors.
  *   @return              true if a match is found.
  *   @stable ICU 3.0
  */
U_CAPI UBool U_EXPORT2 
uregex_find(URegularExpression *regexp,
            int32_t             startIndex, 
            UErrorCode         *status);

/**
  *   64bit version of uregex_find.
  *   Find the first matching substring of the input string that matches the pattern.
  *   If startIndex is >= zero the search for a match begins at the specified index,
  *          and any match region is reset.  This corresponds directly with
  *          Matcher.find(startIndex) in Java.
  *
  *   If startIndex == -1 the search begins at the start of the input region,
  *           or at the start of the full string if no region has been specified.
  *
  *   If a match is found, <code>uregex_start(), uregex_end()</code>, and
  *   <code>uregex_group()</code> will provide more information regarding the match.
  *
  *   @param   regexp      The compiled regular expression.
  *   @param   startIndex  The position (native) in the input string to begin the search, or
  *                        -1 to search within the Input Region.
  *   @param   status      A reference to a UErrorCode to receive any errors.
  *   @return              true if a match is found.
  *   @stable ICU 4.6
  */
U_CAPI UBool U_EXPORT2 
uregex_find64(URegularExpression *regexp,
              int64_t             startIndex, 
              UErrorCode         *status);

/**
  *  Find the next pattern match in the input string.  Begin searching 
  *  the input at the location following the end of he previous match, 
  *  or at the start of the string (or region) if there is no 
  *  previous match.  If a match is found, <code>uregex_start(), uregex_end()</code>, and
  *  <code>uregex_group()</code> will provide more information regarding the match.
  *
  *  @param   regexp      The compiled regular expression.
  *  @param   status      A reference to a UErrorCode to receive any errors.
  *  @return              true if a match is found.
  *  @see uregex_reset
  *  @stable ICU 3.0
  */
U_CAPI UBool U_EXPORT2 
uregex_findNext(URegularExpression *regexp,
                UErrorCode         *status);

/**
  *   Get the number of capturing groups in this regular expression's pattern.
  *   @param   regexp      The compiled regular expression.
  *   @param   status      A reference to a UErrorCode to receive any errors.
  *   @return the number of capture groups
  *   @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_groupCount(URegularExpression *regexp,
                  UErrorCode         *status);

/**
  * Get the group number corresponding to a named capture group.
  * The returned number can be used with any function that access
  * capture groups by number.
  *
  * The function returns an error status if the specified name does not
  * appear in the pattern.
  *
  * @param  regexp      The compiled regular expression.
  * @param  groupName   The capture group name.
  * @param  nameLength  The length of the name, or -1 if the name is a
  *                     nul-terminated string.
  * @param  status      A pointer to a UErrorCode to receive any errors.
  *
  * @stable ICU 55
  */
U_CAPI int32_t U_EXPORT2
uregex_groupNumberFromName(URegularExpression *regexp,
                           const UChar        *groupName,
                           int32_t             nameLength,
                           UErrorCode          *status);


/**
  * Get the group number corresponding to a named capture group.
  * The returned number can be used with any function that access
  * capture groups by number.
  *
  * The function returns an error status if the specified name does not
  * appear in the pattern.
  *
  * @param  regexp      The compiled regular expression.
  * @param  groupName   The capture group name,
  *                     platform invariant characters only.
  * @param  nameLength  The length of the name, or -1 if the name is
  *                     nul-terminated.
  * @param  status      A pointer to a UErrorCode to receive any errors.
  *
  * @stable ICU 55
  */
U_CAPI int32_t U_EXPORT2
uregex_groupNumberFromCName(URegularExpression *regexp,
                            const char         *groupName,
                            int32_t             nameLength,
                            UErrorCode          *status);

/** Extract the string for the specified matching expression or subexpression.
  * Group #0 is the complete string of matched text.
  * Group #1 is the text matched by the first set of capturing parentheses.
  *
  *   @param   regexp       The compiled regular expression.
  *   @param   groupNum     The capture group to extract.  Group 0 is the complete
  *                         match.  The value of this parameter must be
  *                         less than or equal to the number of capture groups in
  *                         the pattern.
  *   @param   dest         Buffer to receive the matching string data
  *   @param   destCapacity Capacity of the dest buffer.
  *   @param   status       A reference to a UErrorCode to receive any errors.
  *   @return               Length of matching data,
  *                         or -1 if no applicable match.
  *   @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_group(URegularExpression *regexp,
             int32_t             groupNum,
             UChar              *dest,
             int32_t             destCapacity,
             UErrorCode          *status);

/** Returns a shallow immutable clone of the entire input string with the current index set
  *   to the beginning of the requested capture group.  The capture group length is also
  *   returned via groupLength.
  * Group #0 is the complete string of matched text.
  * Group #1 is the text matched by the first set of capturing parentheses.
  *
  *   @param   regexp       The compiled regular expression.
  *   @param   groupNum     The capture group to extract.  Group 0 is the complete
  *                         match.  The value of this parameter must be
  *                         less than or equal to the number of capture groups in
  *                         the pattern.
  *   @param   dest         A mutable UText in which to store the current input.
  *                         If NULL, a new UText will be created as an immutable shallow clone
  *                         of the entire input string.
  *   @param   groupLength  The group length of the desired capture group. Output parameter.
  *   @param   status       A reference to a UErrorCode to receive any errors.
  *   @return               The subject text currently associated with this regular expression.
  *                         If a pre-allocated UText was provided, it will always be used and returned.

  *
  *   @stable ICU 4.6
  */
U_CAPI UText * U_EXPORT2 
uregex_groupUText(URegularExpression *regexp,
                  int32_t             groupNum,
                  UText              *dest,
                  int64_t            *groupLength,
                  UErrorCode         *status);

/**
  *   Returns the index in the input string of the start of the text matched by the
  *   specified capture group during the previous match operation.  Return -1 if
  *   the capture group was not part of the last match.
  *   Group #0 refers to the complete range of matched text.
  *   Group #1 refers to the text matched by the first set of capturing parentheses.
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   groupNum    The capture group number
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @return              the starting (native) position in the input of the text matched 
  *                         by the specified group.
  *    @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_start(URegularExpression *regexp,
             int32_t             groupNum,
             UErrorCode          *status);

/**
  *   64bit version of uregex_start.
  *   Returns the index in the input string of the start of the text matched by the
  *   specified capture group during the previous match operation.  Return -1 if
  *   the capture group was not part of the last match.
  *   Group #0 refers to the complete range of matched text.
  *   Group #1 refers to the text matched by the first set of capturing parentheses.
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   groupNum    The capture group number
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @return              the starting (native) position in the input of the text matched 
  *                         by the specified group.
  *   @stable ICU 4.6
  */
U_CAPI int64_t U_EXPORT2 
uregex_start64(URegularExpression *regexp,
               int32_t             groupNum,
               UErrorCode          *status);

/**
  *   Returns the index in the input string of the position following the end
  *   of the text matched by the specified capture group.
  *   Return -1 if the capture group was not part of the last match.
  *   Group #0 refers to the complete range of matched text.
  *   Group #1 refers to the text matched by the first set of capturing parentheses.
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   groupNum    The capture group number
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @return              the (native) index of the position following the last matched character.
  *    @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_end(URegularExpression   *regexp,
           int32_t               groupNum,
           UErrorCode           *status);

/**
  *   64bit version of uregex_end.
  *   Returns the index in the input string of the position following the end
  *   of the text matched by the specified capture group.
  *   Return -1 if the capture group was not part of the last match.
  *   Group #0 refers to the complete range of matched text.
  *   Group #1 refers to the text matched by the first set of capturing parentheses.
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   groupNum    The capture group number
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @return              the (native) index of the position following the last matched character.
  *   @stable ICU 4.6
  */
U_CAPI int64_t U_EXPORT2 
uregex_end64(URegularExpression *regexp,
             int32_t               groupNum,
             UErrorCode           *status);

/**
  *  Reset any saved state from the previous match.  Has the effect of
  *  causing uregex_findNext to begin at the specified index, and causing
  *  uregex_start(), uregex_end() and uregex_group() to return an error 
  *  indicating that there is no match information available.  Clears any
  *  match region that may have been set.
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   index       The position (native) in the text at which a
  *                         uregex_findNext() should begin searching.
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @stable ICU 3.0
  */
U_CAPI void U_EXPORT2 
uregex_reset(URegularExpression    *regexp,
             int32_t               index,
             UErrorCode            *status);

/**
  *  64bit version of uregex_reset.
  *  Reset any saved state from the previous match.  Has the effect of
  *  causing uregex_findNext to begin at the specified index, and causing
  *  uregex_start(), uregex_end() and uregex_group() to return an error 
  *  indicating that there is no match information available.  Clears any
  *  match region that may have been set.
  *
  *    @param   regexp      The compiled regular expression.
  *    @param   index       The position (native) in the text at which a
  *                         uregex_findNext() should begin searching.
  *    @param   status      A reference to a UErrorCode to receive any errors.
  *    @stable ICU 4.6
  */
U_CAPI void U_EXPORT2 
uregex_reset64(URegularExpression  *regexp,
               int64_t               index,
               UErrorCode            *status);

/**
  * Sets the limits of the matching region for this URegularExpression.
  * The region is the part of the input string that will be considered when matching.
  * Invoking this method resets any saved state from the previous match, 
  * then sets the region to start at the index specified by the start parameter
  * and end at the index specified by the end parameter.
  *
  * Depending on the transparency and anchoring being used (see useTransparentBounds
  * and useAnchoringBounds), certain constructs such as anchors may behave differently
  * at or around the boundaries of the region
  *
  * The function will fail if start is greater than limit, or if either index
  *  is less than zero or greater than the length of the string being matched.
  *
  * @param regexp The compiled regular expression.
  * @param regionStart  The (native) index to begin searches at.
  * @param regionLimit  The (native) index to end searches at (exclusive).
  * @param status A pointer to a UErrorCode to receive any errors.
  * @stable ICU 4.0
  */
U_CAPI void U_EXPORT2
uregex_setRegion(URegularExpression   *regexp,
                 int32_t               regionStart,
                 int32_t               regionLimit,
                 UErrorCode           *status);

/**
  * 64bit version of uregex_setRegion.
  * Sets the limits of the matching region for this URegularExpression.
  * The region is the part of the input string that will be considered when matching.
  * Invoking this method resets any saved state from the previous match, 
  * then sets the region to start at the index specified by the start parameter
  * and end at the index specified by the end parameter.
  *
  * Depending on the transparency and anchoring being used (see useTransparentBounds
  * and useAnchoringBounds), certain constructs such as anchors may behave differently
  * at or around the boundaries of the region
  *
  * The function will fail if start is greater than limit, or if either index
  *  is less than zero or greater than the length of the string being matched.
  *
  * @param regexp The compiled regular expression.
  * @param regionStart  The (native) index to begin searches at.
  * @param regionLimit  The (native) index to end searches at (exclusive).
  * @param status A pointer to a UErrorCode to receive any errors.
  * @stable ICU 4.6
  */
U_CAPI void U_EXPORT2 
uregex_setRegion64(URegularExpression *regexp,
                 int64_t               regionStart,
                 int64_t               regionLimit,
                 UErrorCode           *status);

/**
  *  Set the matching region and the starting index for subsequent matches
  *  in a single operation.
  *  This is useful because the usual function for setting the starting
  *  index, urgex_reset(), also resets any region limits.
  *
  * @param regexp The compiled regular expression.
  * @param regionStart  The (native) index to begin searches at.
  * @param regionLimit  The (native) index to end searches at (exclusive).
  * @param startIndex   The index in the input text at which the next 
  *                     match operation should begin.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @stable ICU 4.6
  */
U_CAPI void U_EXPORT2 
uregex_setRegionAndStart(URegularExpression *regexp,
                 int64_t               regionStart,
                 int64_t               regionLimit,
                 int64_t               startIndex,
                 UErrorCode           *status);

/**
  * Reports the start index of the matching region. Any matches found are limited to
  * to the region bounded by regionStart (inclusive) and regionEnd (exclusive).
  *
  * @param regexp The compiled regular expression.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @return The starting (native) index of this matcher's region.
  * @stable ICU 4.0
  */
U_CAPI int32_t U_EXPORT2
uregex_regionStart(const  URegularExpression   *regexp,
                          UErrorCode           *status);

/**
  * 64bit version of uregex_regionStart.
  * Reports the start index of the matching region. Any matches found are limited to
  * to the region bounded by regionStart (inclusive) and regionEnd (exclusive).
  *
  * @param regexp The compiled regular expression.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @return The starting (native) index of this matcher's region.
  * @stable ICU 4.6
  */
U_CAPI int64_t U_EXPORT2 
uregex_regionStart64(const  URegularExpression   *regexp,
                            UErrorCode           *status);

/**
  * Reports the end index (exclusive) of the matching region for this URegularExpression.
  * Any matches found are limited to to the region bounded by regionStart (inclusive)
  * and regionEnd (exclusive).
  *
  * @param regexp The compiled regular expression.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @return The ending point (native) of this matcher's region.
  * @stable ICU 4.0
  */
U_CAPI int32_t U_EXPORT2
uregex_regionEnd(const  URegularExpression   *regexp,
                        UErrorCode           *status);

/**
  * 64bit version of uregex_regionEnd.
  * Reports the end index (exclusive) of the matching region for this URegularExpression.
  * Any matches found are limited to to the region bounded by regionStart (inclusive)
  * and regionEnd (exclusive).
  *
  * @param regexp The compiled regular expression.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @return The ending point (native) of this matcher's region.
  * @stable ICU 4.6
  */
U_CAPI int64_t U_EXPORT2 
uregex_regionEnd64(const  URegularExpression   *regexp,
                          UErrorCode           *status);

/**
  * Queries the transparency of region bounds for this URegularExpression.
  * See useTransparentBounds for a description of transparent and opaque bounds.
  * By default, matching boundaries are opaque.
  *
  * @param regexp The compiled regular expression.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @return true if this matcher is using opaque bounds, false if it is not.
  * @stable ICU 4.0
  */
U_CAPI UBool U_EXPORT2
uregex_hasTransparentBounds(const  URegularExpression   *regexp,
                                   UErrorCode           *status);


/**
  * Sets the transparency of region bounds for this URegularExpression.
  * Invoking this function with an argument of true will set matches to use transparent bounds.
  * If the boolean argument is false, then opaque bounds will be used.
  *
  * Using transparent bounds, the boundaries of the matching region are transparent
  * to lookahead, lookbehind, and boundary matching constructs. Those constructs can
  * see text beyond the boundaries of the region while checking for a match.
  *
  * With opaque bounds, no text outside of the matching region is visible to lookahead,
  * lookbehind, and boundary matching constructs.
  *
  * By default, opaque bounds are used.
  *
  * @param   regexp The compiled regular expression.
  * @param   b      true for transparent bounds; false for opaque bounds
  * @param   status A pointer to a UErrorCode to receive any errors.
  * @stable ICU 4.0
  **/
U_CAPI void U_EXPORT2  
uregex_useTransparentBounds(URegularExpression   *regexp, 
                            UBool                b,
                            UErrorCode           *status);


/**
  * Return true if this URegularExpression is using anchoring bounds.
  * By default, anchoring region bounds are used.
  *
  * @param  regexp The compiled regular expression.
  * @param  status A pointer to a UErrorCode to receive any errors.
  * @return true if this matcher is using anchoring bounds.
  * @stable ICU 4.0
  */
U_CAPI UBool U_EXPORT2
uregex_hasAnchoringBounds(const  URegularExpression   *regexp,
                                 UErrorCode           *status);


/**
  * Set whether this URegularExpression is using Anchoring Bounds for its region.
  * With anchoring bounds, pattern anchors such as ^ and $ will match at the start
  * and end of the region.  Without Anchoring Bounds, anchors will only match at
  * the positions they would in the complete text.
  *
  * Anchoring Bounds are the default for regions.
  *
  * @param regexp The compiled regular expression.
  * @param b      true if to enable anchoring bounds; false to disable them.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @stable ICU 4.0
  */
U_CAPI void U_EXPORT2
uregex_useAnchoringBounds(URegularExpression   *regexp,
                          UBool                 b,
                          UErrorCode           *status);

/**
  * Return true if the most recent matching operation touched the
  *  end of the text being processed.  In this case, additional input text could
  *  change the results of that match.
  *
  *  @param regexp The compiled regular expression.
  *  @param status A pointer to a UErrorCode to receive any errors.
  *  @return  true if the most recent match hit the end of input
  *  @stable ICU 4.0
  */
U_CAPI UBool U_EXPORT2
uregex_hitEnd(const  URegularExpression   *regexp,
                     UErrorCode           *status);

/**
  * Return true the most recent match succeeded and additional input could cause
  * it to fail. If this function returns false and a match was found, then more input
  * might change the match but the match won't be lost. If a match was not found,
  * then requireEnd has no meaning.
  *
  * @param regexp The compiled regular expression.
  * @param status A pointer to a UErrorCode to receive any errors.
  * @return true  if more input could cause the most recent match to no longer match.
  * @stable ICU 4.0
  */
U_CAPI UBool U_EXPORT2   
uregex_requireEnd(const  URegularExpression   *regexp,
                         UErrorCode           *status);





/**
  *    Replaces every substring of the input that matches the pattern
  *    with the given replacement string.  This is a convenience function that
  *    provides a complete find-and-replace-all operation.
  *
  *    This method scans the input string looking for matches of the pattern. 
  *    Input that is not part of any match is copied unchanged to the
  *    destination buffer.  Matched regions are replaced in the output
  *    buffer by the replacement string.   The replacement string may contain
  *    references to capture groups; these take the form of $1, $2, etc.
  *
  *    @param   regexp             The compiled regular expression.
  *    @param   replacementText    A string containing the replacement text.
  *    @param   replacementLength  The length of the replacement string, or
  *                                -1 if it is NUL terminated.
  *    @param   destBuf            A (UChar *) buffer that will receive the result.
  *    @param   destCapacity       The capacity of the destination buffer.
  *    @param   status             A reference to a UErrorCode to receive any errors.
  *    @return                     The length of the string resulting from the find
  *                                and replace operation.  In the event that the
  *                                destination capacity is inadequate, the return value
  *                                is still the full length of the untruncated string.
  *    @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_replaceAll(URegularExpression    *regexp,
                  const UChar           *replacementText,
                  int32_t                replacementLength,
                  UChar                 *destBuf,
                  int32_t                destCapacity,
                  UErrorCode            *status);

/**
  *    Replaces every substring of the input that matches the pattern
  *    with the given replacement string.  This is a convenience function that
  *    provides a complete find-and-replace-all operation.
  *
  *    This method scans the input string looking for matches of the pattern. 
  *    Input that is not part of any match is copied unchanged to the
  *    destination buffer.  Matched regions are replaced in the output
  *    buffer by the replacement string.   The replacement string may contain
  *    references to capture groups; these take the form of $1, $2, etc.
  *
  *    @param   regexp         The compiled regular expression.
  *    @param   replacement    A string containing the replacement text.
  *    @param   dest           A mutable UText that will receive the result.
  *                             If NULL, a new UText will be created (which may not be mutable).
  *    @param   status         A reference to a UErrorCode to receive any errors.
  *    @return                 A UText containing the results of the find and replace.
  *                             If a pre-allocated UText was provided, it will always be used and returned.
  *
  *    @stable ICU 4.6
  */
U_CAPI UText * U_EXPORT2 
uregex_replaceAllUText(URegularExpression *regexp,
                       UText              *replacement,
                       UText              *dest,
                       UErrorCode         *status);

/**
  *    Replaces the first substring of the input that matches the pattern
  *    with the given replacement string.  This is a convenience function that
  *    provides a complete find-and-replace operation.
  *
  *    This method scans the input string looking for a match of the pattern. 
  *    All input that is not part of the match is copied unchanged to the
  *    destination buffer.  The matched region is replaced in the output
  *    buffer by the replacement string.   The replacement string may contain
  *    references to capture groups; these take the form of $1, $2, etc.
  *
  *    @param   regexp             The compiled regular expression.
  *    @param   replacementText    A string containing the replacement text.
  *    @param   replacementLength  The length of the replacement string, or
  *                                -1 if it is NUL terminated.
  *    @param   destBuf            A (UChar *) buffer that will receive the result.
  *    @param   destCapacity       The capacity of the destination buffer.
  *    @param   status             a reference to a UErrorCode to receive any errors.
  *    @return                     The length of the string resulting from the find
  *                                and replace operation.  In the event that the
  *                                destination capacity is inadequate, the return value
  *                                is still the full length of the untruncated string.
  *    @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_replaceFirst(URegularExpression  *regexp,
                    const UChar         *replacementText,
                    int32_t              replacementLength,
                    UChar               *destBuf,
                    int32_t              destCapacity,
                    UErrorCode          *status);

/**
  *    Replaces the first substring of the input that matches the pattern
  *    with the given replacement string.  This is a convenience function that
  *    provides a complete find-and-replace operation.
  *
  *    This method scans the input string looking for a match of the pattern. 
  *    All input that is not part of the match is copied unchanged to the
  *    destination buffer.  The matched region is replaced in the output
  *    buffer by the replacement string.   The replacement string may contain
  *    references to capture groups; these take the form of $1, $2, etc.
  *
  *    @param   regexp         The compiled regular expression.
  *    @param   replacement    A string containing the replacement text.
  *    @param   dest           A mutable UText that will receive the result.
  *                             If NULL, a new UText will be created (which may not be mutable).
  *    @param   status         A reference to a UErrorCode to receive any errors.
  *    @return                 A UText containing the results of the find and replace.
  *                             If a pre-allocated UText was provided, it will always be used and returned.
  *
  *    @stable ICU 4.6
  */
U_CAPI UText * U_EXPORT2 
uregex_replaceFirstUText(URegularExpression *regexp,
                         UText              *replacement,
                         UText              *dest,
                         UErrorCode         *status);

/**
  *   Implements a replace operation intended to be used as part of an
  *   incremental find-and-replace.
  *
  *   <p>The input string, starting from the end of the previous match and ending at
  *   the start of the current match, is appended to the destination string.  Then the
  *   replacement string is appended to the output string,
  *   including handling any substitutions of captured text.</p>
  *
  *   <p>A note on preflight computation of buffersize and error handling:
  *   Calls to uregex_appendReplacement() and uregex_appendTail() are
  *   designed to be chained, one after another, with the destination
  *   buffer pointer and buffer capacity updated after each in preparation
  *   to for the next.  If the destination buffer is exhausted partway through such a
  *   sequence, a U_BUFFER_OVERFLOW_ERROR status will be returned.  Normal
  *   ICU conventions are for a function to perform no action if it is
  *   called with an error status, but for this one case, uregex_appendRepacement()
  *   will operate normally so that buffer size computations will complete
  *   correctly.
  *
  *   <p>For simple, prepackaged, non-incremental find-and-replace
  *      operations, see replaceFirst() or replaceAll().</p>
  *
  *   @param   regexp      The regular expression object.  
  *   @param   replacementText The string that will replace the matched portion of the
  *                        input string as it is copied to the destination buffer.
  *                        The replacement text may contain references ($1, for
  *                        example) to capture groups from the match.
  *   @param   replacementLength  The length of the replacement text string,
  *                        or -1 if the string is NUL terminated.
  *   @param   destBuf     The buffer into which the results of the
  *                        find-and-replace are placed.  On return, this pointer
  *                        will be updated to refer to the beginning of the
  *                        unused portion of buffer, leaving it in position for
  *                        a subsequent call to this function.
  *   @param   destCapacity The size of the output buffer,  On return, this
  *                        parameter will be updated to reflect the space remaining
  *                        unused in the output buffer.
  *   @param   status      A reference to a UErrorCode to receive any errors. 
  *   @return              The length of the result string.  In the event that
  *                        destCapacity is inadequate, the full length of the
  *                        untruncated output string is returned.
  *
  *   @stable ICU 3.0
  *
  */
U_CAPI int32_t U_EXPORT2 
uregex_appendReplacement(URegularExpression    *regexp,
                         const UChar           *replacementText,
                         int32_t                replacementLength,
                         UChar                **destBuf,
                         int32_t               *destCapacity,
                         UErrorCode            *status);

/**
  *   Implements a replace operation intended to be used as part of an
  *   incremental find-and-replace.
  *
  *   <p>The input string, starting from the end of the previous match and ending at
  *   the start of the current match, is appended to the destination string.  Then the
  *   replacement string is appended to the output string,
  *   including handling any substitutions of captured text.</p>
  *
  *   <p>For simple, prepackaged, non-incremental find-and-replace
  *      operations, see replaceFirst() or replaceAll().</p>
  *
  *   @param   regexp      The regular expression object.  
  *   @param   replacementText The string that will replace the matched portion of the
  *                        input string as it is copied to the destination buffer.
  *                        The replacement text may contain references ($1, for
  *                        example) to capture groups from the match.
  *   @param   dest        A mutable UText that will receive the result. Must not be NULL.
  *   @param   status      A reference to a UErrorCode to receive any errors. 
  *
  *   @stable ICU 4.6
  */
U_CAPI void U_EXPORT2 
uregex_appendReplacementUText(URegularExpression    *regexp,
                              UText                 *replacementText,
                              UText                 *dest,
                              UErrorCode            *status);

/**
  * As the final step in a find-and-replace operation, append the remainder
  * of the input string, starting at the position following the last match,
  * to the destination string. <code>uregex_appendTail()</code> is intended 
  *  to be invoked after one or more invocations of the
  *  <code>uregex_appendReplacement()</code> function.
  *
  *   @param   regexp      The regular expression object.  This is needed to 
  *                        obtain the input string and with the position
  *                        of the last match within it.
  *   @param   destBuf     The buffer in which the results of the
  *                        find-and-replace are placed.  On return, the pointer
  *                        will be updated to refer to the beginning of the
  *                        unused portion of buffer.
  *   @param   destCapacity The size of the output buffer,  On return, this
  *                        value will be updated to reflect the space remaining
  *                        unused in the output buffer.
  *   @param   status      A reference to a UErrorCode to receive any errors. 
  *   @return              The length of the result string.  In the event that
  *                        destCapacity is inadequate, the full length of the
  *                        untruncated output string is returned.
  *
  *   @stable ICU 3.0
  */
U_CAPI int32_t U_EXPORT2 
uregex_appendTail(URegularExpression    *regexp,
                  UChar                **destBuf,
                  int32_t               *destCapacity,
                  UErrorCode            *status);

/**
  * As the final step in a find-and-replace operation, append the remainder
  * of the input string, starting at the position following the last match,
  * to the destination string. <code>uregex_appendTailUText()</code> is intended 
  *  to be invoked after one or more invocations of the
  *  <code>uregex_appendReplacementUText()</code> function.
  *
  *   @param   regexp      The regular expression object.  This is needed to 
  *                        obtain the input string and with the position
  *                        of the last match within it.
  *   @param   dest        A mutable UText that will receive the result. Must not be NULL.
  *
  *   @param status        Error code
  *
  *   @return              The destination UText.
  *
  *   @stable ICU 4.6
  */
U_CAPI UText * U_EXPORT2 
uregex_appendTailUText(URegularExpression    *regexp,
                       UText                 *dest,
                       UErrorCode            *status);

 /**
   * Split a string into fields.  Somewhat like split() from Perl.
   *  The pattern matches identify delimiters that separate the input
   *  into fields.  The input data between the matches becomes the
   *  fields themselves.
   *
   *  Each of the fields is copied from the input string to the destination
   *  buffer, and NUL terminated.  The position of each field within
   *  the destination buffer is returned in the destFields array.
   *
   *  If the delimiter pattern includes capture groups, the captured text will
   *  also appear in the destination array of output strings, interspersed
   *  with the fields.  This is similar to Perl, but differs from Java, 
   *  which ignores the presence of capture groups in the pattern.
   * 
   *  Trailing empty fields will always be returned, assuming sufficient
   *  destination capacity.  This differs from the default behavior for Java
   *  and Perl where trailing empty fields are not returned.
   *
   *  The number of strings produced by the split operation is returned.
   *  This count includes the strings from capture groups in the delimiter pattern.
   *  This behavior differs from Java, which ignores capture groups.
   * 
   *    @param   regexp      The compiled regular expression.
   *    @param   destBuf     A (UChar *) buffer to receive the fields that
   *                         are extracted from the input string. These
   *                         field pointers will refer to positions within the
   *                         destination buffer supplied by the caller.  Any
   *                         extra positions within the destFields array will be
   *                         set to NULL.
   *    @param   destCapacity The capacity of the destBuf.
   *    @param   requiredCapacity  The actual capacity required of the destBuf.
   *                         If destCapacity is too small, requiredCapacity will return 
   *                         the total capacity required to hold all of the output, and
   *                         a U_BUFFER_OVERFLOW_ERROR will be returned.
   *    @param   destFields  An array to be filled with the position of each
   *                         of the extracted fields within destBuf.
   *    @param   destFieldsCapacity  The number of elements in the destFields array.
   *                If the number of fields found is less than destFieldsCapacity,
   *                the extra destFields elements are set to zero.
   *                If destFieldsCapacity is too small, the trailing part of the
   *                input, including any field delimiters, is treated as if it
   *                were the last field - it is copied to the destBuf, and
   *                its position is in the destBuf is stored in the last element
   *                of destFields.  This behavior mimics that of Perl.  It is not
   *                an error condition, and no error status is returned when all destField
   *                positions are used.
   * @param status  A reference to a UErrorCode to receive any errors.
   * @return        The number of fields into which the input string was split.
   * @stable ICU 3.0
   */
U_CAPI int32_t U_EXPORT2 
uregex_split(   URegularExpression      *regexp,
                  UChar                 *destBuf,
                  int32_t                destCapacity,
                  int32_t               *requiredCapacity,
                  UChar                 *destFields[],
                  int32_t                destFieldsCapacity,
                  UErrorCode            *status);

  /**
   * Split a string into fields.  Somewhat like split() from Perl.
   * The pattern matches identify delimiters that separate the input
   *  into fields.  The input data between the matches becomes the
   *  fields themselves.
   * <p>
   * The behavior of this function is not very closely aligned with uregex_split();
   * instead, it is based on (and implemented directly on top of) the C++ split method.
   *
   * @param regexp  The compiled regular expression.
   * @param destFields    An array of mutable UText structs to receive the results of the split.
   *                If a field is NULL, a new UText is allocated to contain the results for
   *                that field. This new UText is not guaranteed to be mutable.
   * @param destFieldsCapacity  The number of elements in the destination array.
   *                If the number of fields found is less than destCapacity, the
   *                extra strings in the destination array are not altered.
   *                If the number of destination strings is less than the number
   *                of fields, the trailing part of the input string, including any
   *                field delimiters, is placed in the last destination string.
   *                This behavior mimics that of Perl.  It is not  an error condition, and no
   *                error status is returned when all destField positions are used.
   * @param status  A reference to a UErrorCode to receive any errors.
   * @return        The number of fields into which the input string was split.
   *
   * @stable ICU 4.6
   */
U_CAPI int32_t U_EXPORT2 
uregex_splitUText(URegularExpression    *regexp,
                  UText                 *destFields[],
                  int32_t                destFieldsCapacity,
                  UErrorCode            *status);

/**
 * Set a processing time limit for match operations with this URegularExpression.
 *
 * Some patterns, when matching certain strings, can run in exponential time.
 * For practical purposes, the match operation may appear to be in an
 * infinite loop.
 * When a limit is set a match operation will fail with an error if the
 * limit is exceeded.
 * <p>
 * The units of the limit are steps of the match engine.
 * Correspondence with actual processor time will depend on the speed
 * of the processor and the details of the specific pattern, but will
 * typically be on the order of milliseconds.
 * <p>
 * By default, the matching time is not limited.
 * <p>
 *
 * @param   regexp      The compiled regular expression.
 * @param   limit       The limit value, or 0 for no limit.
 * @param   status      A reference to a UErrorCode to receive any errors.
 * @stable ICU 4.0
 */
U_CAPI void U_EXPORT2
uregex_setTimeLimit(URegularExpression      *regexp,
                    int32_t                  limit,
                    UErrorCode              *status);

/**
 * Get the time limit for for matches with this URegularExpression.
 * A return value of zero indicates that there is no limit.
 *
 * @param   regexp      The compiled regular expression.
 * @param   status      A reference to a UErrorCode to receive any errors.
 * @return the maximum allowed time for a match, in units of processing steps.
 * @stable ICU 4.0
 */
U_CAPI int32_t U_EXPORT2
uregex_getTimeLimit(const URegularExpression      *regexp,
                          UErrorCode              *status);

/**
 * Set the amount of heap storage available for use by the match backtracking stack.
 * <p>
 * ICU uses a backtracking regular expression engine, with the backtrack stack
 * maintained on the heap.  This function sets the limit to the amount of memory
 * that can be used  for this purpose.  A backtracking stack overflow will
 * result in an error from the match operation that caused it.
 * <p>
 * A limit is desirable because a malicious or poorly designed pattern can use
 * excessive memory, potentially crashing the process.  A limit is enabled
 * by default.
 * <p>
 * @param   regexp      The compiled regular expression.
 * @param   limit       The maximum size, in bytes, of the matching backtrack stack.
 *                      A value of zero means no limit.
 *                      The limit must be greater than or equal to zero.
 * @param   status      A reference to a UErrorCode to receive any errors.
 *
 * @stable ICU 4.0
 */
U_CAPI void U_EXPORT2
uregex_setStackLimit(URegularExpression      *regexp,
                     int32_t                  limit,
                     UErrorCode              *status);

/**
 * Get the size of the heap storage available for use by the back tracking stack.
 *
 * @return  the maximum backtracking stack size, in bytes, or zero if the
 *          stack size is unlimited.
 * @stable ICU 4.0
 */
U_CAPI int32_t U_EXPORT2
uregex_getStackLimit(const URegularExpression      *regexp,
                           UErrorCode              *status);


/**
 * Function pointer for a regular expression matching callback function.
 * When set, a callback function will be called periodically during matching
 * operations.  If the call back function returns false, the matching
 * operation will be terminated early.
 *
 * Note:  the callback function must not call other functions on this
 *        URegularExpression.
 *
 * @param context  context pointer.  The callback function will be invoked
 *                 with the context specified at the time that
 *                 uregex_setMatchCallback() is called.
 * @param steps    the accumulated processing time, in match steps, 
 *                 for this matching operation.
 * @return         true to continue the matching operation.
 *                 false to terminate the matching operation.
 * @stable ICU 4.0
 */
U_CDECL_BEGIN
typedef UBool U_CALLCONV URegexMatchCallback (
                   const void *context,
                   int32_t     steps);
U_CDECL_END

/**
 * Set a callback function for this URegularExpression.
 * During matching operations the function will be called periodically,
 * giving the application the opportunity to terminate a long-running
 * match.
 *
 * @param   regexp      The compiled regular expression.
 * @param   callback    A pointer to the user-supplied callback function.
 * @param   context     User context pointer.  The value supplied at the
 *                      time the callback function is set will be saved
 *                      and passed to the callback each time that it is called.
 * @param   status      A reference to a UErrorCode to receive any errors.
 * @stable ICU 4.0
 */
U_CAPI void U_EXPORT2
uregex_setMatchCallback(URegularExpression      *regexp,
                        URegexMatchCallback     *callback,
                        const void              *context,
                        UErrorCode              *status);


/**
 *  Get the callback function for this URegularExpression.
 *
 * @param   regexp      The compiled regular expression.
 * @param   callback    Out parameter, receives a pointer to the user-supplied 
 *                      callback function.
 * @param   context     Out parameter, receives the user context pointer that
 *                      was set when uregex_setMatchCallback() was called.
 * @param   status      A reference to a UErrorCode to receive any errors.
 * @stable ICU 4.0
 */
U_CAPI void U_EXPORT2
uregex_getMatchCallback(const URegularExpression    *regexp,
                        URegexMatchCallback        **callback,
                        const void                 **context,
                        UErrorCode                  *status);

/**
 * Function pointer for a regular expression find callback function.
 * 
 * When set, a callback function will be called during a find operation
 * and for operations that depend on find, such as findNext, split and some replace
 * operations like replaceFirst.
 * The callback will usually be called after each attempt at a match, but this is not a
 * guarantee that the callback will be invoked at each character.  For finds where the
 * match engine is invoked at each character, this may be close to true, but less likely
 * for more optimized loops where the pattern is known to only start, and the match
 * engine invoked, at certain characters.
 * When invoked, this callback will specify the index at which a match operation is about
 * to be attempted, giving the application the opportunity to terminate a long-running
 * find operation.
 * 
 * If the call back function returns false, the find operation will be terminated early.
 *
 * Note:  the callback function must not call other functions on this
 *        URegularExpression
 *
 * @param context  context pointer.  The callback function will be invoked
 *                 with the context specified at the time that
 *                 uregex_setFindProgressCallback() is called.
 * @param matchIndex  the next index at which a match attempt will be attempted for this
 *                 find operation.  If this callback interrupts the search, this is the
 *                 index at which a find/findNext operation may be re-initiated.
 * @return         true to continue the matching operation.
 *                 false to terminate the matching operation.
 * @stable ICU 4.6
 */
U_CDECL_BEGIN
typedef UBool U_CALLCONV URegexFindProgressCallback (
                   const void *context,
                   int64_t     matchIndex);
U_CDECL_END


/**
 *  Set the find progress callback function for this URegularExpression.
 *
 * @param   regexp      The compiled regular expression.
 * @param   callback    A pointer to the user-supplied callback function.
 * @param   context     User context pointer.  The value supplied at the
 *                      time the callback function is set will be saved
 *                      and passed to the callback each time that it is called.
 * @param   status      A reference to a UErrorCode to receive any errors.
 * @stable ICU 4.6
 */
U_CAPI void U_EXPORT2
uregex_setFindProgressCallback(URegularExpression              *regexp,
                                URegexFindProgressCallback      *callback,
                                const void                      *context,
                                UErrorCode                      *status);

/**
 *  Get the find progress callback function for this URegularExpression.
 *
 * @param   regexp      The compiled regular expression.
 * @param   callback    Out parameter, receives a pointer to the user-supplied 
 *                      callback function.
 * @param   context     Out parameter, receives the user context pointer that
 *                      was set when uregex_setFindProgressCallback() was called.
 * @param   status      A reference to a UErrorCode to receive any errors.
 * @stable ICU 4.6
 */
U_CAPI void U_EXPORT2
uregex_getFindProgressCallback(const URegularExpression          *regexp,
                                URegexFindProgressCallback        **callback,
                                const void                        **context,
                                UErrorCode                        *status);

#endif   /*  !UCONFIG_NO_REGULAR_EXPRESSIONS  */
#endif   /*  UREGEX_H  */
