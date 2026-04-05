// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 2002-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*   file name:  regex.h
*   encoding:   UTF-8
*   indentation:4
*
*   created on: 2002oct22
*   created by: Andy Heninger
*
*   ICU Regular Expressions, API for C++
*/

#ifndef REGEX_H
#define REGEX_H

//#define REGEX_DEBUG

/**
 * \file
 * \brief C++ API: Regular Expressions
 *
 * The ICU API for processing regular expressions consists of two classes,
 *  `RegexPattern` and `RegexMatcher`.
 *  `RegexPattern` objects represent a pre-processed, or compiled
 *  regular expression.  They are created from a regular expression pattern string,
 *  and can be used to create `RegexMatcher` objects for the pattern.
 *
 * Class `RegexMatcher` bundles together a regular expression
 *  pattern and a target string to which the search pattern will be applied.
 *  `RegexMatcher` includes API for doing plain find or search
 *  operations, for search and replace operations, and for obtaining detailed
 *  information about bounds of a match.
 *
 * Note that by constructing `RegexMatcher` objects directly from regular
 * expression pattern strings application code can be simplified and the explicit
 * need for `RegexPattern` objects can usually be eliminated.
 *
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_REGULAR_EXPRESSIONS

#include "unicode/uobject.h"
#include "unicode/unistr.h"
#include "unicode/utext.h"
#include "unicode/parseerr.h"

#include "unicode/uregex.h"

// Forward Declarations

struct UHashtable;

U_NAMESPACE_BEGIN

struct Regex8BitSet;
class  RegexCImpl;
class  RegexMatcher;
class  RegexPattern;
struct REStackFrame;
class  BreakIterator;
class  UnicodeSet;
class  UVector;
class  UVector32;
class  UVector64;


/**
  * Class `RegexPattern` represents a compiled regular expression.  It includes
  * factory methods for creating a RegexPattern object from the source (string) form
  * of a regular expression, methods for creating RegexMatchers that allow the pattern
  * to be applied to input text, and a few convenience methods for simple common
  * uses of regular expressions.
  *
  * Class RegexPattern is not intended to be subclassed.
  *
  * @stable ICU 2.4
  */
class U_I18N_API RegexPattern final : public UObject {
public:

    /**
     * default constructor.  Create a RegexPattern object that refers to no actual
     *   pattern.  Not normally needed; RegexPattern objects are usually
     *   created using the factory method `compile()`.
     *
     * @stable ICU 2.4
     */
    RegexPattern();

    /**
     * Copy Constructor.  Create a new RegexPattern object that is equivalent
     *                    to the source object.
     * @param source the pattern object to be copied.
     * @stable ICU 2.4
     */
    RegexPattern(const RegexPattern &source);

    /**
     * Destructor.  Note that a RegexPattern object must persist so long as any
     *  RegexMatcher objects that were created from the RegexPattern are active.
     * @stable ICU 2.4
     */
    virtual ~RegexPattern();

    /**
     * Comparison operator.  Two RegexPattern objects are considered equal if they
     * were constructed from identical source patterns using the same #URegexpFlag
     * settings.
     * @param that a RegexPattern object to compare with "this".
     * @return true if the objects are equivalent.
     * @stable ICU 2.4
     */
    bool            operator==(const RegexPattern& that) const;

    /**
     * Comparison operator.  Two RegexPattern objects are considered equal if they
     * were constructed from identical source patterns using the same #URegexpFlag
     * settings.
     * @param that a RegexPattern object to compare with "this".
     * @return true if the objects are different.
     * @stable ICU 2.4
     */
    inline bool     operator!=(const RegexPattern& that) const {return ! operator ==(that);}

    /**
     * Assignment operator.  After assignment, this RegexPattern will behave identically
     *     to the source object.
     * @stable ICU 2.4
     */
    RegexPattern  &operator =(const RegexPattern &source);

    /**
     * Create an exact copy of this RegexPattern object.  Since RegexPattern is not
     * intended to be subclassed, <code>clone()</code> and the copy construction are
     * equivalent operations.
     * @return the copy of this RegexPattern
     * @stable ICU 2.4
     */
    RegexPattern  *clone() const;


   /**
    * Compiles the regular expression in string form into a RegexPattern
    * object.  These compile methods, rather than the constructors, are the usual
    * way that RegexPattern objects are created.
    *
    * Note that RegexPattern objects must not be deleted while RegexMatcher
    * objects created from the pattern are active.  RegexMatchers keep a pointer
    * back to their pattern, so premature deletion of the pattern is a
    * catastrophic error.
    *
    * All #URegexpFlag pattern match mode flags are set to their default values.
    *
    * Note that it is often more convenient to construct a RegexMatcher directly
    *    from a pattern string rather than separately compiling the pattern and
    *    then creating a RegexMatcher object from the pattern.
    *
    * @param regex The regular expression to be compiled.
    * @param pe    Receives the position (line and column nubers) of any error
    *              within the regular expression.)
    * @param status A reference to a UErrorCode to receive any errors.
    * @return      A regexPattern object for the compiled pattern.
    *
    * @stable ICU 2.4
    */
    static RegexPattern * U_EXPORT2 compile( const UnicodeString &regex,
        UParseError          &pe,
        UErrorCode           &status);

   /**
    * Compiles the regular expression in string form into a RegexPattern
    * object.  These compile methods, rather than the constructors, are the usual
    * way that RegexPattern objects are created.
    *
    * Note that RegexPattern objects must not be deleted while RegexMatcher
    * objects created from the pattern are active.  RegexMatchers keep a pointer
    * back to their pattern, so premature deletion of the pattern is a
    * catastrophic error.
    *
    * All #URegexpFlag pattern match mode flags are set to their default values.
    *
    * Note that it is often more convenient to construct a RegexMatcher directly
    *    from a pattern string rather than separately compiling the pattern and
    *    then creating a RegexMatcher object from the pattern.
    *
    * @param regex The regular expression to be compiled. Note, the text referred
    *              to by this UText must not be deleted during the lifetime of the
    *              RegexPattern object or any RegexMatcher object created from it.
    * @param pe    Receives the position (line and column nubers) of any error
    *              within the regular expression.)
    * @param status A reference to a UErrorCode to receive any errors.
    * @return      A regexPattern object for the compiled pattern.
    *
    * @stable ICU 4.6
    */
    static RegexPattern * U_EXPORT2 compile( UText *regex,
        UParseError          &pe,
        UErrorCode           &status);

   /**
    * Compiles the regular expression in string form into a RegexPattern
    * object using the specified #URegexpFlag match mode flags.  These compile methods,
    * rather than the constructors, are the usual way that RegexPattern objects
    * are created.
    *
    * Note that RegexPattern objects must not be deleted while RegexMatcher
    * objects created from the pattern are active.  RegexMatchers keep a pointer
    * back to their pattern, so premature deletion of the pattern is a
    * catastrophic error.
    *
    * Note that it is often more convenient to construct a RegexMatcher directly
    *    from a pattern string instead of than separately compiling the pattern and
    *    then creating a RegexMatcher object from the pattern.
    *
    * @param regex The regular expression to be compiled.
    * @param flags The #URegexpFlag match mode flags to be used, e.g. #UREGEX_CASE_INSENSITIVE.
    * @param pe    Receives the position (line and column numbers) of any error
    *              within the regular expression.)
    * @param status   A reference to a UErrorCode to receive any errors.
    * @return      A regexPattern object for the compiled pattern.
    *
    * @stable ICU 2.4
    */
    static RegexPattern * U_EXPORT2 compile( const UnicodeString &regex,
        uint32_t             flags,
        UParseError          &pe,
        UErrorCode           &status);

   /**
    * Compiles the regular expression in string form into a RegexPattern
    * object using the specified #URegexpFlag match mode flags.  These compile methods,
    * rather than the constructors, are the usual way that RegexPattern objects
    * are created.
    *
    * Note that RegexPattern objects must not be deleted while RegexMatcher
    * objects created from the pattern are active.  RegexMatchers keep a pointer
    * back to their pattern, so premature deletion of the pattern is a
    * catastrophic error.
    *
    * Note that it is often more convenient to construct a RegexMatcher directly
    *    from a pattern string instead of than separately compiling the pattern and
    *    then creating a RegexMatcher object from the pattern.
    *
    * @param regex The regular expression to be compiled. Note, the text referred
    *              to by this UText must not be deleted during the lifetime of the
    *              RegexPattern object or any RegexMatcher object created from it.
    * @param flags The #URegexpFlag match mode flags to be used, e.g. #UREGEX_CASE_INSENSITIVE.
    * @param pe    Receives the position (line and column numbers) of any error
    *              within the regular expression.)
    * @param status   A reference to a UErrorCode to receive any errors.
    * @return      A regexPattern object for the compiled pattern.
    *
    * @stable ICU 4.6
    */
    static RegexPattern * U_EXPORT2 compile( UText *regex,
        uint32_t             flags,
        UParseError          &pe,
        UErrorCode           &status);

   /**
    * Compiles the regular expression in string form into a RegexPattern
    * object using the specified #URegexpFlag match mode flags.  These compile methods,
    * rather than the constructors, are the usual way that RegexPattern objects
    * are created.
    *
    * Note that RegexPattern objects must not be deleted while RegexMatcher
    * objects created from the pattern are active.  RegexMatchers keep a pointer
    * back to their pattern, so premature deletion of the pattern is a
    * catastrophic error.
    *
    * Note that it is often more convenient to construct a RegexMatcher directly
    *    from a pattern string instead of than separately compiling the pattern and
    *    then creating a RegexMatcher object from the pattern.
    *
    * @param regex The regular expression to be compiled.
    * @param flags The #URegexpFlag match mode flags to be used, e.g. #UREGEX_CASE_INSENSITIVE.
    * @param status   A reference to a UErrorCode to receive any errors.
    * @return      A regexPattern object for the compiled pattern.
    *
    * @stable ICU 2.6
    */
    static RegexPattern * U_EXPORT2 compile( const UnicodeString &regex,
        uint32_t             flags,
        UErrorCode           &status);

   /**
    * Compiles the regular expression in string form into a RegexPattern
    * object using the specified #URegexpFlag match mode flags.  These compile methods,
    * rather than the constructors, are the usual way that RegexPattern objects
    * are created.
    *
    * Note that RegexPattern objects must not be deleted while RegexMatcher
    * objects created from the pattern are active.  RegexMatchers keep a pointer
    * back to their pattern, so premature deletion of the pattern is a
    * catastrophic error.
    *
    * Note that it is often more convenient to construct a RegexMatcher directly
    *    from a pattern string instead of than separately compiling the pattern and
    *    then creating a RegexMatcher object from the pattern.
    *
    * @param regex The regular expression to be compiled. Note, the text referred
    *              to by this UText must not be deleted during the lifetime of the
    *              RegexPattern object or any RegexMatcher object created from it.
    * @param flags The #URegexpFlag match mode flags to be used, e.g. #UREGEX_CASE_INSENSITIVE.
    * @param status   A reference to a UErrorCode to receive any errors.
    * @return      A regexPattern object for the compiled pattern.
    *
    * @stable ICU 4.6
    */
    static RegexPattern * U_EXPORT2 compile( UText *regex,
        uint32_t             flags,
        UErrorCode           &status);

   /**
    * Get the #URegexpFlag match mode flags that were used when compiling this pattern.
    * @return  the #URegexpFlag match mode flags
    * @stable ICU 2.4
    */
    uint32_t flags() const;

   /**
    * Creates a RegexMatcher that will match the given input against this pattern.  The
    * RegexMatcher can then be used to perform match, find or replace operations
    * on the input.  Note that a RegexPattern object must not be deleted while
    * RegexMatchers created from it still exist and might possibly be used again.
    *
    * The matcher will retain a reference to the supplied input string, and all regexp
    * pattern matching operations happen directly on this original string.  It is
    * critical that the string not be altered or deleted before use by the regular
    * expression operations is complete.
    *
    * @param input    The input string to which the regular expression will be applied.
    * @param status   A reference to a UErrorCode to receive any errors.
    * @return         A RegexMatcher object for this pattern and input.
    *
    * @stable ICU 2.4
    */
    RegexMatcher *matcher(const UnicodeString &input,
        UErrorCode          &status) const;
        
private:
    /**
     * Cause a compilation error if an application accidentally attempts to
     *   create a matcher with a (char16_t *) string as input rather than
     *   a UnicodeString.  Avoids a dangling reference to a temporary string.
     *
     * To efficiently work with char16_t *strings, wrap the data in a UnicodeString
     * using one of the aliasing constructors, such as
     * `UnicodeString(UBool isTerminated, const char16_t *text, int32_t textLength);`
     * or in a UText, using
     * `utext_openUChars(UText *ut, const char16_t *text, int64_t textLength, UErrorCode *status);`
     *
     */
    RegexMatcher *matcher(const char16_t *input,
        UErrorCode          &status) const = delete;
public:


   /**
    * Creates a RegexMatcher that will match against this pattern.  The
    * RegexMatcher can be used to perform match, find or replace operations.
    * Note that a RegexPattern object must not be deleted while
    * RegexMatchers created from it still exist and might possibly be used again.
    *
    * @param status   A reference to a UErrorCode to receive any errors.
    * @return      A RegexMatcher object for this pattern and input.
    *
    * @stable ICU 2.6
    */
    RegexMatcher *matcher(UErrorCode  &status) const;


   /**
    * Test whether a string matches a regular expression.  This convenience function
    * both compiles the regular expression and applies it in a single operation.
    * Note that if the same pattern needs to be applied repeatedly, this method will be
    * less efficient than creating and reusing a RegexMatcher object.
    *
    * @param regex The regular expression
    * @param input The string data to be matched
    * @param pe Receives the position of any syntax errors within the regular expression
    * @param status A reference to a UErrorCode to receive any errors.
    * @return True if the regular expression exactly matches the full input string.
    *
    * @stable ICU 2.4
    */
    static UBool U_EXPORT2 matches(const UnicodeString   &regex,
        const UnicodeString   &input,
              UParseError     &pe,
              UErrorCode      &status);

   /**
    * Test whether a string matches a regular expression.  This convenience function
    * both compiles the regular expression and applies it in a single operation.
    * Note that if the same pattern needs to be applied repeatedly, this method will be
    * less efficient than creating and reusing a RegexMatcher object.
    *
    * @param regex The regular expression
    * @param input The string data to be matched
    * @param pe Receives the position of any syntax errors within the regular expression
    * @param status A reference to a UErrorCode to receive any errors.
    * @return True if the regular expression exactly matches the full input string.
    *
    * @stable ICU 4.6
    */
    static UBool U_EXPORT2 matches(UText *regex,
        UText           *input,
        UParseError     &pe,
        UErrorCode      &status);

   /**
    * Returns the regular expression from which this pattern was compiled. This method will work
    * even if the pattern was compiled from a UText.
    *
    * Note: If the pattern was originally compiled from a UText, and that UText was modified,
    * the returned string may no longer reflect the RegexPattern object.
    * @stable ICU 2.4
    */
    UnicodeString pattern() const;
    
    
   /**
    * Returns the regular expression from which this pattern was compiled. This method will work
    * even if the pattern was compiled from a UnicodeString.
    *
    * Note: This is the original input, not a clone. If the pattern was originally compiled from a
    * UText, and that UText was modified, the returned UText may no longer reflect the RegexPattern
    * object.
    *
    * @stable ICU 4.6
    */
    UText *patternText(UErrorCode      &status) const;


    /**
     * Get the group number corresponding to a named capture group.
     * The returned number can be used with any function that access
     * capture groups by number.
     *
     * The function returns an error status if the specified name does not
     * appear in the pattern.
     *
     * @param  groupName   The capture group name.
     * @param  status      A UErrorCode to receive any errors.
     *
     * @stable ICU 55
     */
    int32_t groupNumberFromName(const UnicodeString &groupName, UErrorCode &status) const;


    /**
     * Get the group number corresponding to a named capture group.
     * The returned number can be used with any function that access
     * capture groups by number.
     *
     * The function returns an error status if the specified name does not
     * appear in the pattern.
     *
     * @param  groupName   The capture group name,
     *                     platform invariant characters only.
     * @param  nameLength  The length of the name, or -1 if the name is
     *                     nul-terminated.
     * @param  status      A UErrorCode to receive any errors.
     *
     * @stable ICU 55
     */
    int32_t groupNumberFromName(const char *groupName, int32_t nameLength, UErrorCode &status) const;


    /**
     * Split a string into fields.  Somewhat like split() from Perl or Java.
     * Pattern matches identify delimiters that separate the input
     * into fields.  The input data between the delimiters becomes the
     * fields themselves.
     *
     * If the delimiter pattern includes capture groups, the captured text will
     * also appear in the destination array of output strings, interspersed
     * with the fields.  This is similar to Perl, but differs from Java, 
     * which ignores the presence of capture groups in the pattern.
     * 
     * Trailing empty fields will always be returned, assuming sufficient
     * destination capacity.  This differs from the default behavior for Java
     * and Perl where trailing empty fields are not returned.
     *
     * The number of strings produced by the split operation is returned.
     * This count includes the strings from capture groups in the delimiter pattern.
     * This behavior differs from Java, which ignores capture groups.
     *
     * For the best performance on split() operations,
     * <code>RegexMatcher::split</code> is preferable to this function
     *
     * @param input   The string to be split into fields.  The field delimiters
     *                match the pattern (in the "this" object)
     * @param dest    An array of UnicodeStrings to receive the results of the split.
     *                This is an array of actual UnicodeString objects, not an
     *                array of pointers to strings.  Local (stack based) arrays can
     *                work well here.
     * @param destCapacity  The number of elements in the destination array.
     *                If the number of fields found is less than destCapacity, the
     *                extra strings in the destination array are not altered.
     *                If the number of destination strings is less than the number
     *                of fields, the trailing part of the input string, including any
     *                field delimiters, is placed in the last destination string.
     * @param status  A reference to a UErrorCode to receive any errors.
     * @return        The number of fields into which the input string was split.
     * @stable ICU 2.4
     */
    int32_t  split(const UnicodeString &input,
        UnicodeString    dest[],
        int32_t          destCapacity,
        UErrorCode       &status) const;


    /**
     * Split a string into fields.  Somewhat like %split() from Perl or Java.
     * Pattern matches identify delimiters that separate the input
     * into fields.  The input data between the delimiters becomes the
     * fields themselves.
     *
     * If the delimiter pattern includes capture groups, the captured text will
     * also appear in the destination array of output strings, interspersed
     * with the fields.  This is similar to Perl, but differs from Java, 
     * which ignores the presence of capture groups in the pattern.
     * 
     * Trailing empty fields will always be returned, assuming sufficient
     * destination capacity.  This differs from the default behavior for Java
     * and Perl where trailing empty fields are not returned.
     *
     * The number of strings produced by the split operation is returned.
     * This count includes the strings from capture groups in the delimiter pattern.
     * This behavior differs from Java, which ignores capture groups.
     *
     *  For the best performance on split() operations,
     *  `RegexMatcher::split()` is preferable to this function
     *
     * @param input   The string to be split into fields.  The field delimiters
     *                match the pattern (in the "this" object)
     * @param dest    An array of mutable UText structs to receive the results of the split.
     *                If a field is nullptr, a new UText is allocated to contain the results for
     *                that field. This new UText is not guaranteed to be mutable.
     * @param destCapacity  The number of elements in the destination array.
     *                If the number of fields found is less than destCapacity, the
     *                extra strings in the destination array are not altered.
     *                If the number of destination strings is less than the number
     *                of fields, the trailing part of the input string, including any
     *                field delimiters, is placed in the last destination string.
     * @param status  A reference to a UErrorCode to receive any errors.
     * @return        The number of destination strings used.  
     *
     * @stable ICU 4.6
     */
    int32_t  split(UText *input,
        UText            *dest[],
        int32_t          destCapacity,
        UErrorCode       &status) const;


    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 2.4
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 2.4
     */
    static UClassID U_EXPORT2 getStaticClassID();

private:
    //
    //  Implementation Data
    //
    UText          *fPattern;      // The original pattern string.
    UnicodeString  *fPatternString; // The original pattern UncodeString if relevant
    uint32_t        fFlags;        // The flags used when compiling the pattern.
                                   //
    UVector64       *fCompiledPat; // The compiled pattern p-code.
    UnicodeString   fLiteralText;  // Any literal string data from the pattern,
                                   //   after un-escaping, for use during the match.

    UVector         *fSets;        // Any UnicodeSets referenced from the pattern.
    Regex8BitSet    *fSets8;       //      (and fast sets for latin-1 range.)


    UErrorCode      fDeferredStatus; // status if some prior error has left this
                                   //  RegexPattern in an unusable state.

    int32_t         fMinMatchLen;  // Minimum Match Length.  All matches will have length
                                   //   >= this value.  For some patterns, this calculated
                                   //   value may be less than the true shortest
                                   //   possible match.
    
    int32_t         fFrameSize;    // Size of a state stack frame in the
                                   //   execution engine.

    int32_t         fDataSize;     // The size of the data needed by the pattern that
                                   //   does not go on the state stack, but has just
                                   //   a single copy per matcher.

    UVector32       *fGroupMap;    // Map from capture group number to position of
                                   //   the group's variables in the matcher stack frame.

    int32_t         fStartType;    // Info on how a match must start.
    int32_t         fInitialStringIdx;     //
    int32_t         fInitialStringLen;
    UnicodeSet     *fInitialChars;
    UChar32         fInitialChar;
    Regex8BitSet   *fInitialChars8;
    UBool           fNeedsAltInput;

    UHashtable     *fNamedCaptureMap;  // Map from capture group names to numbers.

    friend class RegexCompile;
    friend class RegexMatcher;
    friend class RegexCImpl;

    //
    //  Implementation Methods
    //
    void        init();                 // Common initialization, for use by constructors.
    bool        initNamedCaptureMap();  // Lazy init for fNamedCaptureMap.
    void        zap();                  // Common cleanup

    void        dumpOp(int32_t index) const;

  public:
#ifndef U_HIDE_INTERNAL_API
    /**
      * Dump a compiled pattern. Internal debug function.
      * @internal
      */
    void        dumpPattern() const;
#endif  /* U_HIDE_INTERNAL_API */
};



/**
 *  class RegexMatcher bundles together a regular expression pattern and
 *  input text to which the expression can be applied.  It includes methods
 *  for testing for matches, and for find and replace operations.
 *
 * <p>Class RegexMatcher is not intended to be subclassed.</p>
 *
 * @stable ICU 2.4
 */
class U_I18N_API RegexMatcher final : public UObject {
public:

    /**
      * Construct a RegexMatcher for a regular expression.
      * This is a convenience method that avoids the need to explicitly create
      * a RegexPattern object.  Note that if several RegexMatchers need to be
      * created for the same expression, it will be more efficient to
      * separately create and cache a RegexPattern object, and use
      * its matcher() method to create the RegexMatcher objects.
      *
      *  @param regexp The Regular Expression to be compiled.
      *  @param flags  #URegexpFlag options, such as #UREGEX_CASE_INSENSITIVE.
      *  @param status Any errors are reported by setting this UErrorCode variable.
      *  @stable ICU 2.6
      */
    RegexMatcher(const UnicodeString &regexp, uint32_t flags, UErrorCode &status);

    /**
      * Construct a RegexMatcher for a regular expression.
      * This is a convenience method that avoids the need to explicitly create
      * a RegexPattern object.  Note that if several RegexMatchers need to be
      * created for the same expression, it will be more efficient to
      * separately create and cache a RegexPattern object, and use
      * its matcher() method to create the RegexMatcher objects.
      *
      *  @param regexp The regular expression to be compiled.
      *  @param flags  #URegexpFlag options, such as #UREGEX_CASE_INSENSITIVE.
      *  @param status Any errors are reported by setting this UErrorCode variable.
      *
      *  @stable ICU 4.6
      */
    RegexMatcher(UText *regexp, uint32_t flags, UErrorCode &status);

    /**
      * Construct a RegexMatcher for a regular expression.
      * This is a convenience method that avoids the need to explicitly create
      * a RegexPattern object.  Note that if several RegexMatchers need to be
      * created for the same expression, it will be more efficient to
      * separately create and cache a RegexPattern object, and use
      * its matcher() method to create the RegexMatcher objects.
      *
      * The matcher will retain a reference to the supplied input string, and all regexp
      * pattern matching operations happen directly on the original string.  It is
      * critical that the string not be altered or deleted before use by the regular
      * expression operations is complete.
      *
      *  @param regexp The Regular Expression to be compiled.
      *  @param input  The string to match.  The matcher retains a reference to the
      *                caller's string; mo copy is made.
      *  @param flags  #URegexpFlag options, such as #UREGEX_CASE_INSENSITIVE.
      *  @param status Any errors are reported by setting this UErrorCode variable.
      *  @stable ICU 2.6
      */
    RegexMatcher(const UnicodeString &regexp, const UnicodeString &input,
        uint32_t flags, UErrorCode &status);

    /**
      * Construct a RegexMatcher for a regular expression.
      * This is a convenience method that avoids the need to explicitly create
      * a RegexPattern object.  Note that if several RegexMatchers need to be
      * created for the same expression, it will be more efficient to
      * separately create and cache a RegexPattern object, and use
      * its matcher() method to create the RegexMatcher objects.
      *
      * The matcher will make a shallow clone of the supplied input text, and all regexp
      * pattern matching operations happen on this clone.  While read-only operations on
      * the supplied text are permitted, it is critical that the underlying string not be
      * altered or deleted before use by the regular expression operations is complete.
      *
      *  @param regexp The Regular Expression to be compiled.
      *  @param input  The string to match.  The matcher retains a shallow clone of the text.
      *  @param flags  #URegexpFlag options, such as #UREGEX_CASE_INSENSITIVE.
      *  @param status Any errors are reported by setting this UErrorCode variable.
      *
      *  @stable ICU 4.6
      */
    RegexMatcher(UText *regexp, UText *input,
        uint32_t flags, UErrorCode &status);

private:
    /**
     * Cause a compilation error if an application accidentally attempts to
     *   create a matcher with a (char16_t *) string as input rather than
     *   a UnicodeString.    Avoids a dangling reference to a temporary string.
     *
     * To efficiently work with char16_t *strings, wrap the data in a UnicodeString
     * using one of the aliasing constructors, such as
     * `UnicodeString(UBool isTerminated, const char16_t *text, int32_t textLength);`
     * or in a UText, using
     * `utext_openUChars(UText *ut, const char16_t *text, int64_t textLength, UErrorCode *status);`
     */
    RegexMatcher(const UnicodeString &regexp, const char16_t *input,
        uint32_t flags, UErrorCode &status) = delete;
public:


   /**
    *   Destructor.
    *
    *  @stable ICU 2.4
    */
    virtual ~RegexMatcher();


   /**
    *   Attempts to match the entire input region against the pattern.
    *    @param   status     A reference to a UErrorCode to receive any errors.
    *    @return true if there is a match
    *    @stable ICU 2.4
    */
    UBool matches(UErrorCode &status);


   /**
    *   Resets the matcher, then attempts to match the input beginning 
    *   at the specified startIndex, and extending to the end of the input.
    *   The input region is reset to include the entire input string.
    *   A successful match must extend to the end of the input.
    *    @param   startIndex The input string (native) index at which to begin matching.
    *    @param   status     A reference to a UErrorCode to receive any errors.
    *    @return true if there is a match
    *    @stable ICU 2.8
    */
    UBool matches(int64_t startIndex, UErrorCode &status);


   /**
    *   Attempts to match the input string, starting from the beginning of the region,
    *   against the pattern.  Like the matches() method, this function 
    *   always starts at the beginning of the input region;
    *   unlike that function, it does not require that the entire region be matched.
    *
    *   If the match succeeds then more information can be obtained via the start(),
    *   end(), and group() functions.
    *
    *    @param   status     A reference to a UErrorCode to receive any errors.
    *    @return  true if there is a match at the start of the input string.
    *    @stable ICU 2.4
    */
    UBool lookingAt(UErrorCode &status);


  /**
    *   Attempts to match the input string, starting from the specified index, against the pattern.
    *   The match may be of any length, and is not required to extend to the end
    *   of the input string.  Contrast with match().
    *
    *   If the match succeeds then more information can be obtained via the start(),
    *   end(), and group() functions.
    *
    *    @param   startIndex The input string (native) index at which to begin matching.
    *    @param   status     A reference to a UErrorCode to receive any errors.
    *    @return  true if there is a match.
    *    @stable ICU 2.8
    */
    UBool lookingAt(int64_t startIndex, UErrorCode &status);


   /**
    *  Find the next pattern match in the input string.
    *  The find begins searching the input at the location following the end of
    *  the previous match, or at the start of the string if there is no previous match.
    *  If a match is found, `start()`, `end()` and `group()`
    *  will provide more information regarding the match.
    *  Note that if the input string is changed by the application,
    *     use find(startPos, status) instead of find(), because the saved starting
    *     position may not be valid with the altered input string.
    *  @return  true if a match is found.
    *  @stable ICU 2.4
    */
    UBool find();


   /**
    *  Find the next pattern match in the input string.
    *  The find begins searching the input at the location following the end of
    *  the previous match, or at the start of the string if there is no previous match.
    *  If a match is found, `start()`, `end()` and `group()`
    *  will provide more information regarding the match.
    *
    *  Note that if the input string is changed by the application,
    *  use find(startPos, status) instead of find(), because the saved starting
    *  position may not be valid with the altered input string.
    *  @param   status  A reference to a UErrorCode to receive any errors.
    *  @return  true if a match is found.
    * @stable ICU 55
    */
    UBool find(UErrorCode &status);

   /**
    *   Resets this RegexMatcher and then attempts to find the next substring of the
    *   input string that matches the pattern, starting at the specified index.
    *
    *   @param   start     The (native) index in the input string to begin the search.
    *   @param   status    A reference to a UErrorCode to receive any errors.
    *   @return  true if a match is found.
    *   @stable ICU 2.4
    */
    UBool find(int64_t start, UErrorCode &status);


   /**
    *   Returns a string containing the text matched by the previous match.
    *   If the pattern can match an empty string, an empty string may be returned.
    *   @param   status      A reference to a UErrorCode to receive any errors.
    *                        Possible errors are  U_REGEX_INVALID_STATE if no match
    *                        has been attempted or the last match failed.
    *   @return  a string containing the matched input text.
    *   @stable ICU 2.4
    */
    UnicodeString group(UErrorCode &status) const;


   /**
    *    Returns a string containing the text captured by the given group
    *    during the previous match operation.  Group(0) is the entire match.
    *
    *    A zero length string is returned both for capture groups that did not
    *    participate in the match and for actual zero length matches.
    *    To distinguish between these two cases use the function start(),
    *    which returns -1 for non-participating groups.
    *
    *    @param groupNum the capture group number
    *    @param   status     A reference to a UErrorCode to receive any errors.
    *                        Possible errors are  U_REGEX_INVALID_STATE if no match
    *                        has been attempted or the last match failed and
    *                        U_INDEX_OUTOFBOUNDS_ERROR for a bad capture group number.
    *    @return the captured text
    *    @stable ICU 2.4
    */
    UnicodeString group(int32_t groupNum, UErrorCode &status) const;

   /**
    *   Returns the number of capturing groups in this matcher's pattern.
    *   @return the number of capture groups
    *   @stable ICU 2.4
    */
    int32_t groupCount() const;


   /**
    *   Returns a shallow clone of the entire live input string with the UText current native index
    *   set to the beginning of the requested group.
    *
    *   @param   dest        The UText into which the input should be cloned, or nullptr to create a new UText
    *   @param   group_len   A reference to receive the length of the desired capture group
    *   @param   status      A reference to a UErrorCode to receive any errors.
    *                        Possible errors are  U_REGEX_INVALID_STATE if no match
    *                        has been attempted or the last match failed and
    *                        U_INDEX_OUTOFBOUNDS_ERROR for a bad capture group number.
    *   @return dest if non-nullptr, a shallow copy of the input text otherwise
    *
    *   @stable ICU 4.6
    */
    UText *group(UText *dest, int64_t &group_len, UErrorCode &status) const; 

   /**
    *   Returns a shallow clone of the entire live input string with the UText current native index
    *   set to the beginning of the requested group.
    *
    *   A group length of zero is returned both for capture groups that did not
    *   participate in the match and for actual zero length matches.
    *   To distinguish between these two cases use the function start(),
    *   which returns -1 for non-participating groups.
    *
    *   @param   groupNum   The capture group number.
    *   @param   dest        The UText into which the input should be cloned, or nullptr to create a new UText.
    *   @param   group_len   A reference to receive the length of the desired capture group
    *   @param   status      A reference to a UErrorCode to receive any errors.
    *                        Possible errors are  U_REGEX_INVALID_STATE if no match
    *                        has been attempted or the last match failed and
    *                        U_INDEX_OUTOFBOUNDS_ERROR for a bad capture group number.
    *   @return dest if non-nullptr, a shallow copy of the input text otherwise
    *
    *   @stable ICU 4.6
    */
    UText *group(int32_t groupNum, UText *dest, int64_t &group_len, UErrorCode &status) const;

   /**
    *   Returns the index in the input string of the start of the text matched
    *   during the previous match operation.
    *    @param   status      a reference to a UErrorCode to receive any errors.
    *    @return              The (native) position in the input string of the start of the last match.
    *    @stable ICU 2.4
    */
    int32_t start(UErrorCode &status) const;

   /**
    *   Returns the index in the input string of the start of the text matched
    *   during the previous match operation.
    *    @param   status      a reference to a UErrorCode to receive any errors.
    *    @return              The (native) position in the input string of the start of the last match.
    *   @stable ICU 4.6
    */
    int64_t start64(UErrorCode &status) const;


   /**
    *   Returns the index in the input string of the start of the text matched by the
    *    specified capture group during the previous match operation.  Return -1 if
    *    the capture group exists in the pattern, but was not part of the last match.
    *
    *    @param  group       the capture group number
    *    @param  status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed, and
    *                        U_INDEX_OUTOFBOUNDS_ERROR for a bad capture group number
    *    @return the (native) start position of substring matched by the specified group.
    *    @stable ICU 2.4
    */
    int32_t start(int32_t group, UErrorCode &status) const;

   /**
    *   Returns the index in the input string of the start of the text matched by the
    *    specified capture group during the previous match operation.  Return -1 if
    *    the capture group exists in the pattern, but was not part of the last match.
    *
    *    @param  group       the capture group number.
    *    @param  status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed, and
    *                        U_INDEX_OUTOFBOUNDS_ERROR for a bad capture group number.
    *    @return the (native) start position of substring matched by the specified group.
    *    @stable ICU 4.6
    */
    int64_t start64(int32_t group, UErrorCode &status) const;

   /**
    *    Returns the index in the input string of the first character following the
    *    text matched during the previous match operation.
    *
    *   @param   status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed.
    *    @return the index of the last character matched, plus one.
    *                        The index value returned is a native index, corresponding to
    *                        code units for the underlying encoding type, for example,
    *                        a byte index for UTF-8.
    *   @stable ICU 2.4
    */
    int32_t end(UErrorCode &status) const;

   /**
    *    Returns the index in the input string of the first character following the
    *    text matched during the previous match operation.
    *
    *   @param   status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed.
    *    @return the index of the last character matched, plus one.
    *                        The index value returned is a native index, corresponding to
    *                        code units for the underlying encoding type, for example,
    *                        a byte index for UTF-8.
    *   @stable ICU 4.6
    */
    int64_t end64(UErrorCode &status) const;


   /**
    *    Returns the index in the input string of the character following the
    *    text matched by the specified capture group during the previous match operation.
    *
    *    @param group  the capture group number
    *    @param   status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed and
    *                        U_INDEX_OUTOFBOUNDS_ERROR for a bad capture group number
    *    @return  the index of the first character following the text
    *              captured by the specified group during the previous match operation.
    *              Return -1 if the capture group exists in the pattern but was not part of the match.
    *              The index value returned is a native index, corresponding to
    *              code units for the underlying encoding type, for example,
    *              a byte index for UTF8.
    *    @stable ICU 2.4
    */
    int32_t end(int32_t group, UErrorCode &status) const;

   /**
    *    Returns the index in the input string of the character following the
    *    text matched by the specified capture group during the previous match operation.
    *
    *    @param group  the capture group number
    *    @param   status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed and
    *                        U_INDEX_OUTOFBOUNDS_ERROR for a bad capture group number
    *    @return  the index of the first character following the text
    *              captured by the specified group during the previous match operation.
    *              Return -1 if the capture group exists in the pattern but was not part of the match.
    *              The index value returned is a native index, corresponding to
    *              code units for the underlying encoding type, for example,
    *              a byte index for UTF8.
    *   @stable ICU 4.6
    */
    int64_t end64(int32_t group, UErrorCode &status) const;

   /**
    *   Resets this matcher.  The effect is to remove any memory of previous matches,
    *       and to cause subsequent find() operations to begin at the beginning of
    *       the input string.
    *
    *   @return this RegexMatcher.
    *   @stable ICU 2.4
    */
    RegexMatcher &reset();


   /**
    *   Resets this matcher, and set the current input position.
    *   The effect is to remove any memory of previous matches,
    *       and to cause subsequent find() operations to begin at
    *       the specified (native) position in the input string.
    *
    *   The matcher's region is reset to its default, which is the entire
    *   input string.
    *
    *   An alternative to this function is to set a match region
    *   beginning at the desired index.
    *
    *   @return this RegexMatcher.
    *   @stable ICU 2.8
    */
    RegexMatcher &reset(int64_t index, UErrorCode &status);


   /**
    *   Resets this matcher with a new input string.  This allows instances of RegexMatcher
    *     to be reused, which is more efficient than creating a new RegexMatcher for
    *     each input string to be processed.
    *   @param input The new string on which subsequent pattern matches will operate.
    *                The matcher retains a reference to the callers string, and operates
    *                directly on that.  Ownership of the string remains with the caller.
    *                Because no copy of the string is made, it is essential that the
    *                caller not delete the string until after regexp operations on it
    *                are done.
    *                Note that while a reset on the matcher with an input string that is then
    *                modified across/during matcher operations may be supported currently for UnicodeString,
    *                this was not originally intended behavior, and support for this is not guaranteed
    *                in upcoming versions of ICU.
    *   @return this RegexMatcher.
    *   @stable ICU 2.4
    */
    RegexMatcher &reset(const UnicodeString &input);


   /**
    *   Resets this matcher with a new input string.  This allows instances of RegexMatcher
    *     to be reused, which is more efficient than creating a new RegexMatcher for
    *     each input string to be processed.
    *   @param input The new string on which subsequent pattern matches will operate.
    *                The matcher makes a shallow clone of the given text; ownership of the
    *                original string remains with the caller. Because no deep copy of the
    *                text is made, it is essential that the caller not modify the string
    *                until after regexp operations on it are done.
    *   @return this RegexMatcher.
    *
    *   @stable ICU 4.6
    */
    RegexMatcher &reset(UText *input);


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
    *  Caution:  this function is normally used only by very specialized,
    *  system-level code.  One example use case is with garbage collection that moves
    *  the text in memory.
    *
    * @param input      The new (moved) text string.
    * @param status     Receives errors detected by this function.
    *
    * @stable ICU 4.8 
    */
    RegexMatcher &refreshInputText(UText *input, UErrorCode &status);

private:
    /**
     * Cause a compilation error if an application accidentally attempts to
     *   reset a matcher with a (char16_t *) string as input rather than
     *   a UnicodeString.    Avoids a dangling reference to a temporary string.
     *
     * To efficiently work with char16_t *strings, wrap the data in a UnicodeString
     * using one of the aliasing constructors, such as
     * `UnicodeString(UBool isTerminated, const char16_t *text, int32_t textLength);`
     * or in a UText, using
     * `utext_openUChars(UText *ut, const char16_t *text, int64_t textLength, UErrorCode *status);`
     *
     */
    RegexMatcher &reset(const char16_t *input) = delete;
public:

   /**
    *   Returns the input string being matched.  Ownership of the string belongs to
    *   the matcher; it should not be altered or deleted. This method will work even if the input
    *   was originally supplied as a UText.
    *   @return the input string
    *   @stable ICU 2.4
    */
    const UnicodeString &input() const;
    
   /**
    *   Returns the input string being matched.  This is the live input text; it should not be
    *   altered or deleted. This method will work even if the input was originally supplied as
    *   a UnicodeString.
    *   @return the input text
    *
    *   @stable ICU 4.6
    */
    UText *inputText() const;
    
   /**
    *   Returns the input string being matched, either by copying it into the provided
    *   UText parameter or by returning a shallow clone of the live input. Note that copying
    *   the entire input may cause significant performance and memory issues.
    *   @param dest The UText into which the input should be copied, or nullptr to create a new UText
    *   @param status error code
    *   @return dest if non-nullptr, a shallow copy of the input text otherwise
    *
    *   @stable ICU 4.6
    */
    UText *getInput(UText *dest, UErrorCode &status) const;
    

   /** Sets the limits of this matcher's region.
     * The region is the part of the input string that will be searched to find a match.
     * Invoking this method resets the matcher, and then sets the region to start
     * at the index specified by the start parameter and end at the index specified
     * by the end parameter.
     *
     * Depending on the transparency and anchoring being used (see useTransparentBounds
     * and useAnchoringBounds), certain constructs such as anchors may behave differently
     * at or around the boundaries of the region
     *
     * The function will fail if start is greater than limit, or if either index
     *  is less than zero or greater than the length of the string being matched.
     *
     * @param start  The (native) index to begin searches at.
     * @param limit  The index to end searches at (exclusive).
     * @param status A reference to a UErrorCode to receive any errors.
     * @stable ICU 4.0
     */
     RegexMatcher &region(int64_t start, int64_t limit, UErrorCode &status);

   /** 
     * Identical to region(start, limit, status) but also allows a start position without
     *  resetting the region state.
     * @param regionStart The region start
     * @param regionLimit the limit of the region
     * @param startIndex  The (native) index within the region bounds at which to begin searches.
     * @param status A reference to a UErrorCode to receive any errors.
     *                If startIndex is not within the specified region bounds, 
     *                U_INDEX_OUTOFBOUNDS_ERROR is returned.
     * @stable ICU 4.6
     */
     RegexMatcher &region(int64_t regionStart, int64_t regionLimit, int64_t startIndex, UErrorCode &status);

   /**
     * Reports the start index of this matcher's region. The searches this matcher
     * conducts are limited to finding matches within regionStart (inclusive) and
     * regionEnd (exclusive).
     *
     * @return The starting (native) index of this matcher's region.
     * @stable ICU 4.0
     */
     int32_t regionStart() const;

   /**
     * Reports the start index of this matcher's region. The searches this matcher
     * conducts are limited to finding matches within regionStart (inclusive) and
     * regionEnd (exclusive).
     *
     * @return The starting (native) index of this matcher's region.
     * @stable ICU 4.6
     */
     int64_t regionStart64() const;


    /**
      * Reports the end (limit) index (exclusive) of this matcher's region. The searches
      * this matcher conducts are limited to finding matches within regionStart
      * (inclusive) and regionEnd (exclusive).
      *
      * @return The ending point (native) of this matcher's region.
      * @stable ICU 4.0
      */
      int32_t regionEnd() const;

   /**
     * Reports the end (limit) index (exclusive) of this matcher's region. The searches
     * this matcher conducts are limited to finding matches within regionStart
     * (inclusive) and regionEnd (exclusive).
     *
     * @return The ending point (native) of this matcher's region.
     * @stable ICU 4.6
     */
      int64_t regionEnd64() const;

    /**
      * Queries the transparency of region bounds for this matcher.
      * See useTransparentBounds for a description of transparent and opaque bounds.
      * By default, a matcher uses opaque region boundaries.
      *
      * @return true if this matcher is using opaque bounds, false if it is not.
      * @stable ICU 4.0
      */
      UBool hasTransparentBounds() const;

    /**
      * Sets the transparency of region bounds for this matcher.
      * Invoking this function with an argument of true will set this matcher to use transparent bounds.
      * If the boolean argument is false, then opaque bounds will be used.
      *
      * Using transparent bounds, the boundaries of this matcher's region are transparent
      * to lookahead, lookbehind, and boundary matching constructs. Those constructs can
      * see text beyond the boundaries of the region while checking for a match.
      *
      * With opaque bounds, no text outside of the matcher's region is visible to lookahead,
      * lookbehind, and boundary matching constructs.
      *
      * By default, a matcher uses opaque bounds.
      *
      * @param   b true for transparent bounds; false for opaque bounds
      * @return  This Matcher;
      * @stable ICU 4.0
      **/
      RegexMatcher &useTransparentBounds(UBool b);

     
    /**
      * Return true if this matcher is using anchoring bounds.
      * By default, matchers use anchoring region bounds.
      *
      * @return true if this matcher is using anchoring bounds.
      * @stable ICU 4.0
      */    
      UBool hasAnchoringBounds() const;


    /**
      * Set whether this matcher is using Anchoring Bounds for its region.
      * With anchoring bounds, pattern anchors such as ^ and $ will match at the start
      * and end of the region.  Without Anchoring Bounds, anchors will only match at
      * the positions they would in the complete text.
      *
      * Anchoring Bounds are the default for regions.
      *
      * @param b true if to enable anchoring bounds; false to disable them.
      * @return  This Matcher
      * @stable ICU 4.0
      */
      RegexMatcher &useAnchoringBounds(UBool b);


    /**
      * Return true if the most recent matching operation attempted to access
      *  additional input beyond the available input text.
      *  In this case, additional input text could change the results of the match.
      *
      *  hitEnd() is defined for both successful and unsuccessful matches.
      *  In either case hitEnd() will return true if if the end of the text was
      *  reached at any point during the matching process.
      *
      *  @return  true if the most recent match hit the end of input
      *  @stable ICU 4.0
      */
      UBool hitEnd() const;

    /**
      * Return true the most recent match succeeded and additional input could cause
      * it to fail. If this method returns false and a match was found, then more input
      * might change the match but the match won't be lost. If a match was not found,
      * then requireEnd has no meaning.
      *
      * @return true if more input could cause the most recent match to no longer match.
      * @stable ICU 4.0
      */
      UBool requireEnd() const;


   /**
    *    Returns the pattern that is interpreted by this matcher.
    *    @return  the RegexPattern for this RegexMatcher
    *    @stable ICU 2.4
    */
    const RegexPattern &pattern() const;


   /**
    *    Replaces every substring of the input that matches the pattern
    *    with the given replacement string.  This is a convenience function that
    *    provides a complete find-and-replace-all operation.
    *
    *    This method first resets this matcher. It then scans the input string
    *    looking for matches of the pattern. Input that is not part of any
    *    match is left unchanged; each match is replaced in the result by the
    *    replacement string. The replacement string may contain references to
    *    capture groups.
    *
    *    @param   replacement a string containing the replacement text.
    *    @param   status      a reference to a UErrorCode to receive any errors.
    *    @return              a string containing the results of the find and replace.
    *    @stable ICU 2.4
    */
    UnicodeString replaceAll(const UnicodeString &replacement, UErrorCode &status);


   /**
    *    Replaces every substring of the input that matches the pattern
    *    with the given replacement string.  This is a convenience function that
    *    provides a complete find-and-replace-all operation.
    *
    *    This method first resets this matcher. It then scans the input string
    *    looking for matches of the pattern. Input that is not part of any
    *    match is left unchanged; each match is replaced in the result by the
    *    replacement string. The replacement string may contain references to
    *    capture groups.
    *
    *    @param   replacement a string containing the replacement text.
    *    @param   dest        a mutable UText in which the results are placed.
    *                          If nullptr, a new UText will be created (which may not be mutable).
    *    @param   status      a reference to a UErrorCode to receive any errors.
    *    @return              a string containing the results of the find and replace.
    *                          If a pre-allocated UText was provided, it will always be used and returned.
    *
    *    @stable ICU 4.6
    */
    UText *replaceAll(UText *replacement, UText *dest, UErrorCode &status);
    

   /**
    * Replaces the first substring of the input that matches
    * the pattern with the replacement string.   This is a convenience
    * function that provides a complete find-and-replace operation.
    *
    * This function first resets this RegexMatcher. It then scans the input string
    * looking for a match of the pattern. Input that is not part
    * of the match is appended directly to the result string; the match is replaced
    * in the result by the replacement string. The replacement string may contain
    * references to captured groups.
    *
    * The state of the matcher (the position at which a subsequent find()
    *    would begin) after completing a replaceFirst() is not specified.  The
    *    RegexMatcher should be reset before doing additional find() operations.
    *
    *    @param   replacement a string containing the replacement text.
    *    @param   status      a reference to a UErrorCode to receive any errors.
    *    @return              a string containing the results of the find and replace.
    *    @stable ICU 2.4
    */
    UnicodeString replaceFirst(const UnicodeString &replacement, UErrorCode &status);
    

   /**
    * Replaces the first substring of the input that matches
    * the pattern with the replacement string.   This is a convenience
    * function that provides a complete find-and-replace operation.
    *
    * This function first resets this RegexMatcher. It then scans the input string
    * looking for a match of the pattern. Input that is not part
    * of the match is appended directly to the result string; the match is replaced
    * in the result by the replacement string. The replacement string may contain
    * references to captured groups.
    *
    * The state of the matcher (the position at which a subsequent find()
    *    would begin) after completing a replaceFirst() is not specified.  The
    *    RegexMatcher should be reset before doing additional find() operations.
    *
    *    @param   replacement a string containing the replacement text.
    *    @param   dest        a mutable UText in which the results are placed.
    *                          If nullptr, a new UText will be created (which may not be mutable).
    *    @param   status      a reference to a UErrorCode to receive any errors.
    *    @return              a string containing the results of the find and replace.
    *                          If a pre-allocated UText was provided, it will always be used and returned.
    *
    *    @stable ICU 4.6
    */
    UText *replaceFirst(UText *replacement, UText *dest, UErrorCode &status);
    
    
   /**
    *   Implements a replace operation intended to be used as part of an
    *   incremental find-and-replace.
    *
    *   The input string, starting from the end of the previous replacement and ending at
    *   the start of the current match, is appended to the destination string.  Then the
    *   replacement string is appended to the output string,
    *   including handling any substitutions of captured text.
    *
    *   For simple, prepackaged, non-incremental find-and-replace
    *   operations, see replaceFirst() or replaceAll().
    *
    *   @param   dest        A UnicodeString to which the results of the find-and-replace are appended.
    *   @param   replacement A UnicodeString that provides the text to be substituted for
    *                        the input text that matched the regexp pattern.  The replacement
    *                        text may contain references to captured text from the
    *                        input.
    *   @param   status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed, and U_INDEX_OUTOFBOUNDS_ERROR
    *                        if the replacement text specifies a capture group that
    *                        does not exist in the pattern.
    *
    *   @return  this  RegexMatcher
    *   @stable ICU 2.4
    *
    */
    RegexMatcher &appendReplacement(UnicodeString &dest,
        const UnicodeString &replacement, UErrorCode &status);
    
    
   /**
    *   Implements a replace operation intended to be used as part of an
    *   incremental find-and-replace.
    *
    *   The input string, starting from the end of the previous replacement and ending at
    *   the start of the current match, is appended to the destination string.  Then the
    *   replacement string is appended to the output string,
    *   including handling any substitutions of captured text.
    *
    *   For simple, prepackaged, non-incremental find-and-replace
    *   operations, see replaceFirst() or replaceAll().
    *
    *   @param   dest        A mutable UText to which the results of the find-and-replace are appended.
    *                         Must not be nullptr.
    *   @param   replacement A UText that provides the text to be substituted for
    *                        the input text that matched the regexp pattern.  The replacement
    *                        text may contain references to captured text from the input.
    *   @param   status      A reference to a UErrorCode to receive any errors.  Possible
    *                        errors are  U_REGEX_INVALID_STATE if no match has been
    *                        attempted or the last match failed, and U_INDEX_OUTOFBOUNDS_ERROR
    *                        if the replacement text specifies a capture group that
    *                        does not exist in the pattern.
    *
    *   @return  this  RegexMatcher
    *
    *   @stable ICU 4.6
    */
    RegexMatcher &appendReplacement(UText *dest,
        UText *replacement, UErrorCode &status);


   /**
    * As the final step in a find-and-replace operation, append the remainder
    * of the input string, starting at the position following the last appendReplacement(),
    * to the destination string. `appendTail()` is intended to be invoked after one
    * or more invocations of the `RegexMatcher::appendReplacement()`.
    *
    *  @param dest A UnicodeString to which the results of the find-and-replace are appended.
    *  @return  the destination string.
    *  @stable ICU 2.4
    */
    UnicodeString &appendTail(UnicodeString &dest);


   /**
    * As the final step in a find-and-replace operation, append the remainder
    * of the input string, starting at the position following the last appendReplacement(),
    * to the destination string. `appendTail()` is intended to be invoked after one
    * or more invocations of the `RegexMatcher::appendReplacement()`.
    *
    *  @param dest A mutable UText to which the results of the find-and-replace are appended.
    *               Must not be nullptr.
    *  @param status error cod
    *  @return  the destination string.
    *
    *  @stable ICU 4.6
    */
    UText *appendTail(UText *dest, UErrorCode &status);


    /**
     * Split a string into fields.  Somewhat like %split() from Perl.
     * The pattern matches identify delimiters that separate the input
     *  into fields.  The input data between the matches becomes the
     *  fields themselves.
     *
     * @param input   The string to be split into fields.  The field delimiters
     *                match the pattern (in the "this" object).  This matcher
     *                will be reset to this input string.
     * @param dest    An array of UnicodeStrings to receive the results of the split.
     *                This is an array of actual UnicodeString objects, not an
     *                array of pointers to strings.  Local (stack based) arrays can
     *                work well here.
     * @param destCapacity  The number of elements in the destination array.
     *                If the number of fields found is less than destCapacity, the
     *                extra strings in the destination array are not altered.
     *                If the number of destination strings is less than the number
     *                of fields, the trailing part of the input string, including any
     *                field delimiters, is placed in the last destination string.
     * @param status  A reference to a UErrorCode to receive any errors.
     * @return        The number of fields into which the input string was split.
     * @stable ICU 2.6
     */
     int32_t  split(const UnicodeString &input,
        UnicodeString    dest[],
        int32_t          destCapacity,
        UErrorCode       &status);


    /**
     * Split a string into fields.  Somewhat like %split() from Perl.
     * The pattern matches identify delimiters that separate the input
     *  into fields.  The input data between the matches becomes the
     *  fields themselves.
     *
     * @param input   The string to be split into fields.  The field delimiters
     *                match the pattern (in the "this" object).  This matcher
     *                will be reset to this input string.
     * @param dest    An array of mutable UText structs to receive the results of the split.
     *                If a field is nullptr, a new UText is allocated to contain the results for
     *                that field. This new UText is not guaranteed to be mutable.
     * @param destCapacity  The number of elements in the destination array.
     *                If the number of fields found is less than destCapacity, the
     *                extra strings in the destination array are not altered.
     *                If the number of destination strings is less than the number
     *                of fields, the trailing part of the input string, including any
     *                field delimiters, is placed in the last destination string.
     * @param status  A reference to a UErrorCode to receive any errors.
     * @return        The number of fields into which the input string was split.
     *
     * @stable ICU 4.6
     */
     int32_t  split(UText *input,
        UText           *dest[],
        int32_t          destCapacity,
        UErrorCode       &status);
    
  /**
    *   Set a processing time limit for match operations with this Matcher.
    *  
    *   Some patterns, when matching certain strings, can run in exponential time.
    *   For practical purposes, the match operation may appear to be in an
    *   infinite loop.
    *   When a limit is set a match operation will fail with an error if the
    *   limit is exceeded.
    *
    *   The units of the limit are steps of the match engine.
    *   Correspondence with actual processor time will depend on the speed
    *   of the processor and the details of the specific pattern, but will
    *   typically be on the order of milliseconds.
    *
    *   By default, the matching time is not limited.
    *
    *
    *   @param   limit       The limit value, or 0 for no limit.
    *   @param   status      A reference to a UErrorCode to receive any errors.
    *   @stable ICU 4.0
    */
    void setTimeLimit(int32_t limit, UErrorCode &status);

  /**
    * Get the time limit, if any, for match operations made with this Matcher.
    *
    *   @return the maximum allowed time for a match, in units of processing steps.
    *   @stable ICU 4.0
    */
    int32_t getTimeLimit() const;

  /**
    *  Set the amount of heap storage available for use by the match backtracking stack.
    *  The matcher is also reset, discarding any results from previous matches.
    *
    *  ICU uses a backtracking regular expression engine, with the backtrack stack
    *  maintained on the heap.  This function sets the limit to the amount of memory
    *  that can be used for this purpose.  A backtracking stack overflow will
    *  result in an error from the match operation that caused it.
    *
    *  A limit is desirable because a malicious or poorly designed pattern can use
    *  excessive memory, potentially crashing the process.  A limit is enabled
    *  by default.
    *
    *  @param limit  The maximum size, in bytes, of the matching backtrack stack.
    *                A value of zero means no limit.
    *                The limit must be greater or equal to zero.
    *
    *  @param status   A reference to a UErrorCode to receive any errors.
    *
    *  @stable ICU 4.0
    */
    void setStackLimit(int32_t  limit, UErrorCode &status);
    
  /**
    *  Get the size of the heap storage available for use by the back tracking stack.
    *
    *  @return  the maximum backtracking stack size, in bytes, or zero if the
    *           stack size is unlimited.
    *  @stable ICU 4.0
    */
    int32_t  getStackLimit() const;


  /**
    * Set a callback function for use with this Matcher.
    * During matching operations the function will be called periodically,
    * giving the application the opportunity to terminate a long-running
    * match.
    *
    *    @param   callback    A pointer to the user-supplied callback function.
    *    @param   context     User context pointer.  The value supplied at the
    *                         time the callback function is set will be saved
    *                         and passed to the callback each time that it is called.
    *    @param   status      A reference to a UErrorCode to receive any errors.
    *  @stable ICU 4.0
    */
    void setMatchCallback(URegexMatchCallback     *callback,
                          const void              *context,
                          UErrorCode              &status);


  /**
    *  Get the callback function for this URegularExpression.
    *
    *    @param   callback    Out parameter, receives a pointer to the user-supplied 
    *                         callback function.
    *    @param   context     Out parameter, receives the user context pointer that
    *                         was set when uregex_setMatchCallback() was called.
    *    @param   status      A reference to a UErrorCode to receive any errors.
    *    @stable ICU 4.0
    */
    void getMatchCallback(URegexMatchCallback     *&callback,
                          const void              *&context,
                          UErrorCode              &status);


  /**
    * Set a progress callback function for use with find operations on this Matcher.
    * During find operations, the callback will be invoked after each return from a
    * match attempt, giving the application the opportunity to terminate a long-running
    * find operation.
    *
    *    @param   callback    A pointer to the user-supplied callback function.
    *    @param   context     User context pointer.  The value supplied at the
    *                         time the callback function is set will be saved
    *                         and passed to the callback each time that it is called.
    *    @param   status      A reference to a UErrorCode to receive any errors.
    *    @stable ICU 4.6
    */
    void setFindProgressCallback(URegexFindProgressCallback      *callback,
                                 const void                              *context,
                                 UErrorCode                              &status);


  /**
    *  Get the find progress callback function for this URegularExpression.
    *
    *    @param   callback    Out parameter, receives a pointer to the user-supplied 
    *                         callback function.
    *    @param   context     Out parameter, receives the user context pointer that
    *                         was set when uregex_setFindProgressCallback() was called.
    *    @param   status      A reference to a UErrorCode to receive any errors.
    *    @stable ICU 4.6
    */
    void getFindProgressCallback(URegexFindProgressCallback      *&callback,
                                 const void                      *&context,
                                 UErrorCode                      &status);

#ifndef U_HIDE_INTERNAL_API
   /**
     *   setTrace   Debug function, enable/disable tracing of the matching engine.
     *              For internal ICU development use only.  DO NO USE!!!!
     *   @internal
     */
    void setTrace(UBool state);
#endif  /* U_HIDE_INTERNAL_API */

    /**
    * ICU "poor man's RTTI", returns a UClassID for this class.
    *
    * @stable ICU 2.2
    */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 2.2
     */
    virtual UClassID getDynamicClassID() const override;

private:
    // Constructors and other object boilerplate are private.
    // Instances of RegexMatcher can not be assigned, copied, cloned, etc.
    RegexMatcher() = delete;                  // default constructor not implemented
    RegexMatcher(const RegexPattern *pat);
    RegexMatcher(const RegexMatcher &other) = delete;
    RegexMatcher &operator =(const RegexMatcher &rhs) = delete;
    void init(UErrorCode &status);                      // Common initialization
    void init2(UText *t, UErrorCode &e);  // Common initialization, part 2.

    friend class RegexPattern;
    friend class RegexCImpl;
public:
#ifndef U_HIDE_INTERNAL_API
    /** @internal  */
    void resetPreserveRegion();  // Reset matcher state, but preserve any region.
#endif  /* U_HIDE_INTERNAL_API */
private:

    //
    //  MatchAt   This is the internal interface to the match engine itself.
    //            Match status comes back in matcher member variables.
    //
    void                 MatchAt(int64_t startIdx, UBool toEnd, UErrorCode &status);
    inline void          backTrack(int64_t &inputIdx, int32_t &patIdx);
    UBool                isWordBoundary(int64_t pos);         // perform Perl-like  \b test
    UBool                isUWordBoundary(int64_t pos, UErrorCode &status);   // perform RBBI based \b test
    // Find a grapheme cluster boundary using a break iterator. For handling \X in regexes.
    int64_t              followingGCBoundary(int64_t pos, UErrorCode &status);
    REStackFrame        *resetStack();
    inline REStackFrame *StateSave(REStackFrame *fp, int64_t savePatIdx, UErrorCode &status);
    void                 IncrementTime(UErrorCode &status);

    // Call user find callback function, if set. Return true if operation should be interrupted.
    inline UBool         findProgressInterrupt(int64_t matchIndex, UErrorCode &status);
    
    int64_t              appendGroup(int32_t groupNum, UText *dest, UErrorCode &status) const;
    
    UBool                findUsingChunk(UErrorCode &status);
    void                 MatchChunkAt(int32_t startIdx, UBool toEnd, UErrorCode &status);
    UBool                isChunkWordBoundary(int32_t pos);

    const RegexPattern  *fPattern;
    RegexPattern        *fPatternOwned;    // Non-nullptr if this matcher owns the pattern, and
                                           //   should delete it when through.

    const UnicodeString *fInput;           // The string being matched. Only used for input()
    UText               *fInputText;       // The text being matched. Is never nullptr.
    UText               *fAltInputText;    // A shallow copy of the text being matched.
                                           //   Only created if the pattern contains backreferences.
    int64_t              fInputLength;     // Full length of the input text.
    int32_t              fFrameSize;       // The size of a frame in the backtrack stack.
    
    int64_t              fRegionStart;     // Start of the input region, default = 0.
    int64_t              fRegionLimit;     // End of input region, default to input.length.
    
    int64_t              fAnchorStart;     // Region bounds for anchoring operations (^ or $).
    int64_t              fAnchorLimit;     //   See useAnchoringBounds
    
    int64_t              fLookStart;       // Region bounds for look-ahead/behind and
    int64_t              fLookLimit;       //   and other boundary tests.  See
                                           //   useTransparentBounds

    int64_t              fActiveStart;     // Currently active bounds for matching.
    int64_t              fActiveLimit;     //   Usually is the same as region, but
                                           //   is changed to fLookStart/Limit when
                                           //   entering look around regions.

    UBool                fTransparentBounds;  // True if using transparent bounds.
    UBool                fAnchoringBounds; // True if using anchoring bounds.

    UBool                fMatch;           // True if the last attempted match was successful.
    int64_t              fMatchStart;      // Position of the start of the most recent match
    int64_t              fMatchEnd;        // First position after the end of the most recent match
                                           //   Zero if no previous match, even when a region
                                           //   is active.
    int64_t              fLastMatchEnd;    // First position after the end of the previous match,
                                           //   or -1 if there was no previous match.
    int64_t              fAppendPosition;  // First position after the end of the previous
                                           //   appendReplacement().  As described by the
                                           //   JavaDoc for Java Matcher, where it is called 
                                           //   "append position"
    UBool                fHitEnd;          // True if the last match touched the end of input.
    UBool                fRequireEnd;      // True if the last match required end-of-input
                                           //    (matched $ or Z)

    UVector64           *fStack;
    REStackFrame        *fFrame;           // After finding a match, the last active stack frame,
                                           //   which will contain the capture group results.
                                           //   NOT valid while match engine is running.

    int64_t             *fData;            // Data area for use by the compiled pattern.
    int64_t             fSmallData[8];     //   Use this for data if it's enough.

    int32_t             fTimeLimit;        // Max time (in arbitrary steps) to let the
                                           //   match engine run.  Zero for unlimited.
    
    int32_t             fTime;             // Match time, accumulates while matching.
    int32_t             fTickCounter;      // Low bits counter for time.  Counts down StateSaves.
                                           //   Kept separately from fTime to keep as much
                                           //   code as possible out of the inline
                                           //   StateSave function.

    int32_t             fStackLimit;       // Maximum memory size to use for the backtrack
                                           //   stack, in bytes.  Zero for unlimited.

    URegexMatchCallback *fCallbackFn;       // Pointer to match progress callback funct.
                                           //   nullptr if there is no callback.
    const void         *fCallbackContext;  // User Context ptr for callback function.

    URegexFindProgressCallback  *fFindProgressCallbackFn;  // Pointer to match progress callback funct.
                                                           //   nullptr if there is no callback.
    const void         *fFindProgressCallbackContext;      // User Context ptr for callback function.


    UBool               fInputUniStrMaybeMutable;  // Set when fInputText wraps a UnicodeString that may be mutable - compatibility.

    UBool               fTraceDebug;       // Set true for debug tracing of match engine.

    UErrorCode          fDeferredStatus;   // Save error state that cannot be immediately
                                           //   reported, or that permanently disables this matcher.

    BreakIterator       *fWordBreakItr;
    BreakIterator       *fGCBreakItr;
};

U_NAMESPACE_END
#endif  // UCONFIG_NO_REGULAR_EXPRESSIONS

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
