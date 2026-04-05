// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
* Copyright (C) 2007-2013, International Business Machines Corporation and
* others. All Rights Reserved.
********************************************************************************
*
* File MSGFMT.H
*
* Modification History:
*
*   Date        Name        Description
*   02/19/97    aliu        Converted from java.
*   03/20/97    helena      Finished first cut of implementation.
*   07/22/98    stephen     Removed operator!= (defined in Format)
*   08/19/2002  srl         Removing Javaisms
*******************************************************************************/

#ifndef MSGFMT_H
#define MSGFMT_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Formats messages in a language-neutral way.
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/format.h"
#include "unicode/locid.h"
#include "unicode/messagepattern.h"
#include "unicode/parseerr.h"
#include "unicode/plurfmt.h"
#include "unicode/plurrule.h"

U_CDECL_BEGIN
// Forward declaration.
struct UHashtable;
typedef struct UHashtable UHashtable; /**< @internal */
U_CDECL_END

U_NAMESPACE_BEGIN

class AppendableWrapper;
class DateFormat;
class NumberFormat;

/**
 * <p>MessageFormat prepares strings for display to users,
 * with optional arguments (variables/placeholders).
 * The arguments can occur in any order, which is necessary for translation
 * into languages with different grammars.
 *
 * <p>A MessageFormat is constructed from a <em>pattern</em> string
 * with arguments in {curly braces} which will be replaced by formatted values.
 *
 * <p><code>MessageFormat</code> differs from the other <code>Format</code>
 * classes in that you create a <code>MessageFormat</code> object with one
 * of its constructors (not with a <code>createInstance</code> style factory
 * method). Factory methods aren't necessary because <code>MessageFormat</code>
 * itself doesn't implement locale-specific behavior. Any locale-specific
 * behavior is defined by the pattern that you provide and the
 * subformats used for inserted arguments.
 *
 * <p>Arguments can be named (using identifiers) or numbered (using small ASCII-digit integers).
 * Some of the API methods work only with argument numbers and throw an exception
 * if the pattern has named arguments (see {@link #usesNamedArguments()}).
 *
 * <p>An argument might not specify any format type. In this case,
 * a numeric value is formatted with a default (for the locale) NumberFormat,
 * and a date/time value is formatted with a default (for the locale) DateFormat.
 *
 * <p>An argument might specify a "simple" type for which the specified
 * Format object is created, cached and used.
 *
 * <p>An argument might have a "complex" type with nested MessageFormat sub-patterns.
 * During formatting, one of these sub-messages is selected according to the argument value
 * and recursively formatted.
 *
 * <p>After construction, a custom Format object can be set for
 * a top-level argument, overriding the default formatting and parsing behavior
 * for that argument.
 * However, custom formatting can be achieved more simply by writing
 * a typeless argument in the pattern string
 * and supplying it with a preformatted string value.
 *
 * <p>When formatting, MessageFormat takes a collection of argument values
 * and writes an output string.
 * The argument values may be passed as an array
 * (when the pattern contains only numbered arguments)
 * or as an array of names and and an array of arguments (which works for both named
 * and numbered arguments).
 *
 * <p>Each argument is matched with one of the input values by array index or argument name
 * and formatted according to its pattern specification
 * (or using a custom Format object if one was set).
 * A numbered pattern argument is matched with an argument name that contains that number
 * as an ASCII-decimal-digit string (without leading zero).
 *
 * <h4><a name="patterns">Patterns and Their Interpretation</a></h4>
 *
 * <code>MessageFormat</code> uses patterns of the following form:
 * <pre>
 * message = messageText (argument messageText)*
 * argument = noneArg | simpleArg | complexArg
 * complexArg = choiceArg | pluralArg | selectArg | selectordinalArg
 *
 * noneArg = '{' argNameOrNumber '}'
 * simpleArg = '{' argNameOrNumber ',' argType [',' argStyle] '}'
 * choiceArg = '{' argNameOrNumber ',' "choice" ',' choiceStyle '}'
 * pluralArg = '{' argNameOrNumber ',' "plural" ',' pluralStyle '}'
 * selectArg = '{' argNameOrNumber ',' "select" ',' selectStyle '}'
 * selectordinalArg = '{' argNameOrNumber ',' "selectordinal" ',' pluralStyle '}'
 *
 * choiceStyle: see {@link ChoiceFormat}
 * pluralStyle: see {@link PluralFormat}
 * selectStyle: see {@link SelectFormat}
 *
 * argNameOrNumber = argName | argNumber
 * argName = [^[[:Pattern_Syntax:][:Pattern_White_Space:]]]+
 * argNumber = '0' | ('1'..'9' ('0'..'9')*)
 *
 * argType = "number" | "date" | "time" | "spellout" | "ordinal" | "duration"
 * argStyle = "short" | "medium" | "long" | "full" | "integer" | "currency" | "percent" | argStyleText | "::" argSkeletonText
 * </pre>
 *
 * <ul>
 *   <li>messageText can contain quoted literal strings including syntax characters.
 *       A quoted literal string begins with an ASCII apostrophe and a syntax character
 *       (usually a {curly brace}) and continues until the next single apostrophe.
 *       A double ASCII apostrophe inside or outside of a quoted string represents
 *       one literal apostrophe.
 *   <li>Quotable syntax characters are the {curly braces} in all messageText parts,
 *       plus the '#' sign in a messageText immediately inside a pluralStyle,
 *       and the '|' symbol in a messageText immediately inside a choiceStyle.
 *   <li>See also {@link #UMessagePatternApostropheMode}
 *   <li>In argStyleText, every single ASCII apostrophe begins and ends quoted literal text,
 *       and unquoted {curly braces} must occur in matched pairs.
 * </ul>
 *
 * <p>Recommendation: Use the real apostrophe (single quote) character
 * \htmlonly&#x2019;\endhtmlonly (U+2019) for
 * human-readable text, and use the ASCII apostrophe ' (U+0027)
 * only in program syntax, like quoting in MessageFormat.
 * See the annotations for U+0027 Apostrophe in The Unicode Standard.
 *
 * <p>The <code>choice</code> argument type is deprecated.
 * Use <code>plural</code> arguments for proper plural selection,
 * and <code>select</code> arguments for simple selection among a fixed set of choices.
 *
 * <p>The <code>argType</code> and <code>argStyle</code> values are used to create
 * a <code>Format</code> instance for the format element. The following
 * table shows how the values map to Format instances. Combinations not
 * shown in the table are illegal. Any <code>argStyleText</code> must
 * be a valid pattern string for the Format subclass used.
 *
 * <p><table border=1>
 *    <tr>
 *       <th>argType
 *       <th>argStyle
 *       <th>resulting Format object
 *    <tr>
 *       <td colspan=2><i>(none)</i>
 *       <td><code>null</code>
 *    <tr>
 *       <td rowspan=6><code>number</code>
 *       <td><i>(none)</i>
 *       <td><code>NumberFormat.createInstance(getLocale(), status)</code>
 *    <tr>
 *       <td><code>integer</code>
 *       <td><code>NumberFormat.createInstance(getLocale(), kNumberStyle, status)</code>
 *    <tr>
 *       <td><code>currency</code>
 *       <td><code>NumberFormat.createCurrencyInstance(getLocale(), status)</code>
 *    <tr>
 *       <td><code>percent</code>
 *       <td><code>NumberFormat.createPercentInstance(getLocale(), status)</code>
 *    <tr>
 *       <td><i>argStyleText</i>
 *       <td><code>new DecimalFormat(argStyleText, new DecimalFormatSymbols(getLocale(), status), status)</code>
 *    <tr>
 *       <td><i>argSkeletonText</i>
 *       <td><code>NumberFormatter::forSkeleton(argSkeletonText, status).locale(getLocale()).toFormat(status)</code>
 *    <tr>
 *       <td rowspan=7><code>date</code>
 *       <td><i>(none)</i>
 *       <td><code>DateFormat.createDateInstance(kDefault, getLocale(), status)</code>
 *    <tr>
 *       <td><code>short</code>
 *       <td><code>DateFormat.createDateInstance(kShort, getLocale(), status)</code>
 *    <tr>
 *       <td><code>medium</code>
 *       <td><code>DateFormat.createDateInstance(kDefault, getLocale(), status)</code>
 *    <tr>
 *       <td><code>long</code>
 *       <td><code>DateFormat.createDateInstance(kLong, getLocale(), status)</code>
 *    <tr>
 *       <td><code>full</code>
 *       <td><code>DateFormat.createDateInstance(kFull, getLocale(), status)</code>
 *    <tr>
 *       <td><i>argStyleText</i>
 *       <td><code>new SimpleDateFormat(argStyleText, getLocale(), status)</code>
 *    <tr>
 *       <td><i>argSkeletonText</i>
 *       <td><code>DateFormat::createInstanceForSkeleton(argSkeletonText, getLocale(), status)</code>
 *    <tr>
 *       <td rowspan=6><code>time</code>
 *       <td><i>(none)</i>
 *       <td><code>DateFormat.createTimeInstance(kDefault, getLocale(), status)</code>
 *    <tr>
 *       <td><code>short</code>
 *       <td><code>DateFormat.createTimeInstance(kShort, getLocale(), status)</code>
 *    <tr>
 *       <td><code>medium</code>
 *       <td><code>DateFormat.createTimeInstance(kDefault, getLocale(), status)</code>
 *    <tr>
 *       <td><code>long</code>
 *       <td><code>DateFormat.createTimeInstance(kLong, getLocale(), status)</code>
 *    <tr>
 *       <td><code>full</code>
 *       <td><code>DateFormat.createTimeInstance(kFull, getLocale(), status)</code>
 *    <tr>
 *       <td><i>argStyleText</i>
 *       <td><code>new SimpleDateFormat(argStyleText, getLocale(), status)</code>
 *    <tr>
 *       <td><code>spellout</code>
 *       <td><i>argStyleText (optional)</i>
 *       <td><code>new RuleBasedNumberFormat(URBNF_SPELLOUT, getLocale(), status)
 *           <br/>&nbsp;&nbsp;&nbsp;&nbsp;.setDefaultRuleset(argStyleText, status);</code>
 *    <tr>
 *       <td><code>ordinal</code>
 *       <td><i>argStyleText (optional)</i>
 *       <td><code>new RuleBasedNumberFormat(URBNF_ORDINAL, getLocale(), status)
 *           <br/>&nbsp;&nbsp;&nbsp;&nbsp;.setDefaultRuleset(argStyleText, status);</code>
 *    <tr>
 *       <td><code>duration</code>
 *       <td><i>argStyleText (optional)</i>
 *       <td><code>new RuleBasedNumberFormat(URBNF_DURATION, getLocale(), status)
 *           <br/>&nbsp;&nbsp;&nbsp;&nbsp;.setDefaultRuleset(argStyleText, status);</code>
 * </table>
 * <p>
 *
 * <h4>Argument formatting</h4>
 *
 * <p>Arguments are formatted according to their type, using the default
 * ICU formatters for those types, unless otherwise specified.</p>
 *
 * <p>There are also several ways to control the formatting.</p>
 *
 * <p>We recommend you use default styles, predefined style values, skeletons,
 * or preformatted values, but not pattern strings or custom format objects.</p>
 *
 * <p>For more details, see the
 * <a href="https://unicode-org.github.io/icu/userguide/format_parse/messages">ICU User Guide</a>.</p>
 *
 * <h4>Usage Information</h4>
 *
 * <p>Here are some examples of usage:
 * Example 1:
 *
 * <pre>
 * \code
 *     UErrorCode success = U_ZERO_ERROR;
 *     GregorianCalendar cal(success);
 *     Formattable arguments[] = {
 *         7L,
 *         Formattable( (Date) cal.getTime(success), Formattable::kIsDate),
 *         "a disturbance in the Force"
 *     };
 *
 *     UnicodeString result;
 *     MessageFormat::format(
 *          "At {1,time,::jmm} on {1,date,::dMMMM}, there was {2} on planet {0,number}.",
 *          arguments, 3, result, success );
 *
 *     cout << "result: " << result << endl;
 *     //<output>: At 4:34 PM on March 23, there was a disturbance
 *     //             in the Force on planet 7.
 * \endcode
 * </pre>
 *
 * Typically, the message format will come from resources, and the
 * arguments will be dynamically set at runtime.
 *
 * <p>Example 2:
 *
 * <pre>
 *  \code
 *     success = U_ZERO_ERROR;
 *     Formattable testArgs[] = {3L, "MyDisk"};
 *
 *     MessageFormat form(
 *         "The disk \"{1}\" contains {0} file(s).", success );
 *
 *     UnicodeString string;
 *     FieldPosition fpos = 0;
 *     cout << "format: " << form.format(testArgs, 2, string, fpos, success ) << endl;
 *
 *     // output, with different testArgs:
 *     // output: The disk "MyDisk" contains 0 file(s).
 *     // output: The disk "MyDisk" contains 1 file(s).
 *     // output: The disk "MyDisk" contains 1,273 file(s).
 *  \endcode
 *  </pre>
 *
 *
 * <p>For messages that include plural forms, you can use a plural argument:
 * <pre>
 * \code
 *  success = U_ZERO_ERROR;
 *  MessageFormat msgFmt(
 *       "{num_files, plural, "
 *       "=0{There are no files on disk \"{disk_name}\".}"
 *       "=1{There is one file on disk \"{disk_name}\".}"
 *       "other{There are # files on disk \"{disk_name}\".}}",
 *      Locale("en"),
 *      success);
 *  FieldPosition fpos = 0;
 *  Formattable testArgs[] = {0L, "MyDisk"};
 *  UnicodeString testArgsNames[] = {"num_files", "disk_name"};
 *  UnicodeString result;
 *  cout << msgFmt.format(testArgs, testArgsNames, 2, result, fpos, 0, success);
 *  testArgs[0] = 3L;
 *  cout << msgFmt.format(testArgs, testArgsNames, 2, result, fpos, 0, success);
 * \endcode
 * <em>output</em>:
 * There are no files on disk "MyDisk".
 * There are 3 files on "MyDisk".
 * </pre>
 * See {@link PluralFormat} and {@link PluralRules} for details.
 *
 * <h4><a name="synchronization">Synchronization</a></h4>
 *
 * <p>MessageFormats are not synchronized.
 * It is recommended to create separate format instances for each thread.
 * If multiple threads access a format concurrently, it must be synchronized
 * externally.
 *
 * @stable ICU 2.0
 */
class U_I18N_API_CLASS MessageFormat : public Format {
public:
#ifndef U_HIDE_OBSOLETE_API
    /**
     * Enum type for kMaxFormat.
     * @obsolete ICU 3.0.  The 10-argument limit was removed as of ICU 2.6,
     * rendering this enum type obsolete.
     */
    enum EFormatNumber {
        /**
         * The maximum number of arguments.
         * @obsolete ICU 3.0.  The 10-argument limit was removed as of ICU 2.6,
         * rendering this constant obsolete.
         */
        kMaxFormat = 10
    };
#endif  /* U_HIDE_OBSOLETE_API */

    /**
     * Constructs a new MessageFormat using the given pattern and the
     * default locale.
     *
     * @param pattern   Pattern used to construct object.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @stable ICU 2.0
     */
    U_I18N_API MessageFormat(const UnicodeString& pattern, UErrorCode& status);

    /**
     * Constructs a new MessageFormat using the given pattern and locale.
     * @param pattern   Pattern used to construct object.
     * @param newLocale The locale to use for formatting dates and numbers.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @stable ICU 2.0
     */
    U_I18N_API MessageFormat(const UnicodeString& pattern, const Locale& newLocale, UErrorCode& status);
    /**
     * Constructs a new MessageFormat using the given pattern and locale.
     * @param pattern   Pattern used to construct object.
     * @param newLocale The locale to use for formatting dates and numbers.
     * @param parseError Struct to receive information on the position
     *                   of an error within the pattern.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @stable ICU 2.0
     */
    U_I18N_API MessageFormat(const UnicodeString& pattern,
                             const Locale& newLocale,
                             UParseError& parseError,
                             UErrorCode& status);
    /**
     * Constructs a new MessageFormat from an existing one.
     * @stable ICU 2.0
     */
    U_I18N_API MessageFormat(const MessageFormat&);

    /**
     * Assignment operator.
     * @stable ICU 2.0
     */
    U_I18N_API const MessageFormat& operator=(const MessageFormat&);

    /**
     * Destructor.
     * @stable ICU 2.0
     */
    U_I18N_API virtual ~MessageFormat();

    /**
     * Clones this Format object polymorphically.  The caller owns the
     * result and should delete it when done.
     * @stable ICU 2.0
     */
    U_I18N_API virtual MessageFormat* clone() const override;

    /**
     * Returns true if the given Format objects are semantically equal.
     * Objects of different subclasses are considered unequal.
     * @param other  the object to be compared with.
     * @return       true if the given Format objects are semantically equal.
     * @stable ICU 2.0
     */
    U_I18N_API virtual bool operator==(const Format& other) const override;

    /**
     * Sets the locale to be used for creating argument Format objects.
     * @param theLocale    the new locale value to be set.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void setLocale(const Locale& theLocale);

    /**
     * Gets the locale used for creating argument Format objects.
     * format information.
     * @return    the locale of the object.
     * @stable ICU 2.0
     */
    U_I18N_API virtual const Locale& getLocale() const;

    /**
     * Applies the given pattern string to this message format.
     *
     * @param pattern   The pattern to be applied.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void applyPattern(const UnicodeString& pattern, UErrorCode& status);
    /**
     * Applies the given pattern string to this message format.
     *
     * @param pattern    The pattern to be applied.
     * @param parseError Struct to receive information on the position
     *                   of an error within the pattern.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void applyPattern(const UnicodeString& pattern,
                                         UParseError& parseError,
                                         UErrorCode& status);

    /**
     * Sets the UMessagePatternApostropheMode and the pattern used by this message format.
     * Parses the pattern and caches Format objects for simple argument types.
     * Patterns and their interpretation are specified in the
     * <a href="#patterns">class description</a>.
     * <p>
     * This method is best used only once on a given object to avoid confusion about the mode,
     * and after constructing the object with an empty pattern string to minimize overhead.
     *
     * @param pattern    The pattern to be applied.
     * @param aposMode   The new apostrophe mode.
     * @param parseError Struct to receive information on the position
     *                   of an error within the pattern.
     *                   Can be nullptr.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @stable ICU 4.8
     */
    U_I18N_API virtual void applyPattern(const UnicodeString& pattern,
                                         UMessagePatternApostropheMode aposMode,
                                         UParseError* parseError,
                                         UErrorCode& status);

    /**
     * @return this instance's UMessagePatternApostropheMode.
     * @stable ICU 4.8
     */
    U_I18N_API UMessagePatternApostropheMode getApostropheMode() const {
        return msgPattern.getApostropheMode();
    }

    /**
     * Returns a pattern that can be used to recreate this object.
     *
     * @param appendTo  Output parameter to receive the pattern.
     *                  Result is appended to existing contents.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UnicodeString& toPattern(UnicodeString& appendTo) const;

    /**
     * Sets subformats.
     * See the class description about format numbering.
     * The caller should not delete the Format objects after this call.
     * <EM>The array formatsToAdopt is not itself adopted.</EM> Its
     * ownership is retained by the caller. If the call fails because
     * memory cannot be allocated, then the formats will be deleted
     * by this method, and this object will remain unchanged.
     *
     * <p>If this format uses named arguments, the new formats are discarded
     * and this format remains unchanged.
     *
     * @stable ICU 2.0
     * @param formatsToAdopt    the format to be adopted.
     * @param count             the size of the array.
     */
    U_I18N_API virtual void adoptFormats(Format** formatsToAdopt, int32_t count);

    /**
     * Sets subformats.
     * See the class description about format numbering.
     * Each item in the array is cloned into the internal array.
     * If the call fails because memory cannot be allocated, then this
     * object will remain unchanged.
     *
     * <p>If this format uses named arguments, the new formats are discarded
     * and this format remains unchanged.
     *
     * @stable ICU 2.0
     * @param newFormats the new format to be set.
     * @param cnt        the size of the array.
     */
    U_I18N_API virtual void setFormats(const Format** newFormats, int32_t cnt);

    /**
     * Sets one subformat.
     * See the class description about format numbering.
     * The caller should not delete the Format object after this call.
     * If the number is over the number of formats already set,
     * the item will be deleted and ignored.
     *
     * <p>If this format uses named arguments, the new format is discarded
     * and this format remains unchanged.
     *
     * @stable ICU 2.0
     * @param formatNumber     index of the subformat.
     * @param formatToAdopt    the format to be adopted.
     */
    U_I18N_API virtual void adoptFormat(int32_t formatNumber, Format* formatToAdopt);

    /**
     * Sets one subformat.
     * See the class description about format numbering.
     * If the number is over the number of formats already set,
     * the item will be ignored.
     * @param formatNumber     index of the subformat.
     * @param format    the format to be set.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void setFormat(int32_t formatNumber, const Format& format);

    /**
     * Gets format names. This function returns formatNames in StringEnumerations
     * which can be used with getFormat() and setFormat() to export formattable
     * array from current MessageFormat to another.  It is the caller's responsibility
     * to delete the returned formatNames.
     * @param status  output param set to success/failure code.
     * @stable ICU 4.0
     */
    U_I18N_API virtual StringEnumeration* getFormatNames(UErrorCode& status);

    /**
     * Gets subformat pointer for given format name.
     * This function supports both named and numbered
     * arguments. If numbered, the formatName is the
     * corresponding UnicodeStrings (e.g. "0", "1", "2"...).
     * The returned Format object should not be deleted by the caller,
     * nor should the pointer of other object .  The pointer and its
     * contents remain valid only until the next call to any method
     * of this class is made with this object.
     * @param formatName the name or number specifying a format
     * @param status  output param set to success/failure code.
     * @stable ICU 4.0
     */
    U_I18N_API virtual Format* getFormat(const UnicodeString& formatName, UErrorCode& status);

    /**
     * Sets one subformat for given format name.
     * See the class description about format name.
     * This function supports both named and numbered
     * arguments-- if numbered, the formatName is the
     * corresponding UnicodeStrings (e.g. "0", "1", "2"...).
     * If there is no matched formatName or wrong type,
     * the item will be ignored.
     * @param formatName  Name of the subformat.
     * @param format      the format to be set.
     * @param status  output param set to success/failure code.
     * @stable ICU 4.0
     */
    U_I18N_API virtual void setFormat(const UnicodeString& formatName,
                                      const Format& format,
                                      UErrorCode& status);

    /**
     * Sets one subformat for given format name.
     * See the class description about format name.
     * This function supports both named and numbered
     * arguments-- if numbered, the formatName is the
     * corresponding UnicodeStrings (e.g. "0", "1", "2"...).
     * If there is no matched formatName or wrong type,
     * the item will be ignored.
     * The caller should not delete the Format object after this call.
     * @param formatName  Name of the subformat.
     * @param formatToAdopt  Format to be adopted.
     * @param status      output param set to success/failure code.
     * @stable ICU 4.0
     */
    U_I18N_API virtual void adoptFormat(const UnicodeString& formatName,
                                        Format* formatToAdopt,
                                        UErrorCode& status);

    /**
     * Gets an array of subformats of this object.  The returned array
     * should not be deleted by the caller, nor should the pointers
     * within the array.  The array and its contents remain valid only
     * until the next call to this format. See the class description
     * about format numbering.
     *
     * @param count output parameter to receive the size of the array
     * @return an array of count Format* objects, or nullptr if out of
     * memory.  Any or all of the array elements may be nullptr.
     * @stable ICU 2.0
     */
    U_I18N_API virtual const Format** getFormats(int32_t& count) const;

    using Format::format;

    /**
     * Formats the given array of arguments into a user-readable string.
     * Does not take ownership of the Formattable* array or its contents.
     *
     * <p>If this format uses named arguments, appendTo is unchanged and
     * status is set to U_ILLEGAL_ARGUMENT_ERROR.
     *
     * @param source    An array of objects to be formatted.
     * @param count     The number of elements of 'source'.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param ignore    Not used; inherited from base class API.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API UnicodeString& format(const Formattable* source,
                                     int32_t count,
                                     UnicodeString& appendTo,
                                     FieldPosition& ignore,
                                     UErrorCode& status) const;

    /**
     * Formats the given array of arguments into a user-readable string
     * using the given pattern.
     *
     * <p>If this format uses named arguments, appendTo is unchanged and
     * status is set to U_ILLEGAL_ARGUMENT_ERROR.
     *
     * @param pattern   The pattern.
     * @param arguments An array of objects to be formatted.
     * @param count     The number of elements of 'source'.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API static UnicodeString& format(const UnicodeString& pattern,
                                            const Formattable* arguments,
                                            int32_t count,
                                            UnicodeString& appendTo,
                                            UErrorCode& status);

    /**
     * Formats the given array of arguments into a user-readable
     * string.  The array must be stored within a single Formattable
     * object of type kArray. If the Formattable object type is not of
     * type kArray, then returns a failing UErrorCode.
     *
     * <p>If this format uses named arguments, appendTo is unchanged and
     * status is set to U_ILLEGAL_ARGUMENT_ERROR.
     *
     * @param obj       A Formattable of type kArray containing
     *                  arguments to be formatted.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UnicodeString& format(const Formattable& obj,
                                             UnicodeString& appendTo,
                                             FieldPosition& pos,
                                             UErrorCode& status) const override;

    /**
     * Formats the given array of arguments into a user-defined argument name
     * array. This function supports both named and numbered
     * arguments-- if numbered, the formatName is the
     * corresponding UnicodeStrings (e.g. "0", "1", "2"...).
     *
     * @param argumentNames argument name array
     * @param arguments An array of objects to be formatted.
     * @param count     The number of elements of 'argumentNames' and
     *                  arguments.  The number of argumentNames and arguments
     *                  must be the same.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 4.0
     */
    U_I18N_API UnicodeString& format(const UnicodeString* argumentNames,
                                     const Formattable* arguments,
                                     int32_t count,
                                     UnicodeString& appendTo,
                                     UErrorCode& status) const;
    /**
     * Parses the given string into an array of output arguments.
     *
     * @param source    String to be parsed.
     * @param pos       On input, starting position for parse. On output,
     *                  final position after parse.  Unchanged if parse
     *                  fails.
     * @param count     Output parameter to receive the number of arguments
     *                  parsed.
     * @return an array of parsed arguments.  The caller owns both
     * the array and its contents.
     * @stable ICU 2.0
     */
    U_I18N_API virtual Formattable* parse(const UnicodeString& source,
                                          ParsePosition& pos,
                                          int32_t& count) const;

    /**
     * Parses the given string into an array of output arguments.
     *
     * <p>If this format uses named arguments, status is set to
     * U_ARGUMENT_TYPE_MISMATCH.
     *
     * @param source    String to be parsed.
     * @param count     Output param to receive size of returned array.
     * @param status    Input/output error code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @return an array of parsed arguments.  The caller owns both
     * the array and its contents. Returns nullptr if status is not U_ZERO_ERROR.
     *
     * @stable ICU 2.0
     */
    U_I18N_API virtual Formattable* parse(const UnicodeString& source,
                                          int32_t& count,
                                          UErrorCode& status) const;

    /**
     * Parses the given string into an array of output arguments
     * stored within a single Formattable of type kArray.
     *
     * @param source    The string to be parsed into an object.
     * @param result    Formattable to be set to the parse result.
     *                  If parse fails, return contents are undefined.
     * @param pos       On input, starting position for parse. On output,
     *                  final position after parse.  Unchanged if parse
     *                  fails.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void parseObject(const UnicodeString& source,
                                        Formattable& result,
                                        ParsePosition& pos) const override;

    /**
     * Convert an 'apostrophe-friendly' pattern into a standard
     * pattern.  Standard patterns treat all apostrophes as
     * quotes, which is problematic in some languages, e.g.
     * French, where apostrophe is commonly used.  This utility
     * assumes that only an unpaired apostrophe immediately before
     * a brace is a true quote.  Other unpaired apostrophes are paired,
     * and the resulting standard pattern string is returned.
     *
     * <p><b>Note</b> it is not guaranteed that the returned pattern
     * is indeed a valid pattern.  The only effect is to convert
     * between patterns having different quoting semantics.
     *
     * @param pattern the 'apostrophe-friendly' patttern to convert
     * @param status    Input/output error code.  If the pattern
     *                  cannot be parsed, the failure code is set.
     * @return the standard equivalent of the original pattern
     * @stable ICU 3.4
     */
    U_I18N_API static UnicodeString autoQuoteApostrophe(const UnicodeString& pattern, UErrorCode& status);

    /**
     * Returns true if this MessageFormat uses named arguments,
     * and false otherwise.  See class description.
     *
     * @return true if named arguments are used.
     * @stable ICU 4.0
     */
    U_I18N_API UBool usesNamedArguments() const;

#ifndef U_HIDE_INTERNAL_API
    /**
     * This API is for ICU internal use only.
     * Please do not use it.
     *
     * Returns argument types count in the parsed pattern.
     * Used to distinguish pattern "{0} d" and "d".
     *
     * @return           The number of formattable types in the pattern
     * @internal
     */
    U_I18N_API int32_t getArgTypeCount() const;
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Returns a unique class ID POLYMORPHICALLY.  Pure virtual override.
     * This method is to implement a simple version of RTTI, since not all
     * C++ compilers support genuine RTTI.  Polymorphic operator==() and
     * clone() methods call this method.
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override;

    /**
     * Return the class ID for this class.  This is useful only for
     * comparing to a return value from getDynamicClassID().  For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .      Derived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    U_I18N_API static UClassID getStaticClassID();

#ifndef U_HIDE_INTERNAL_API
    /**
     * Compares two Format objects. This is used for constructing the hash
     * tables.
     *
     * @param left pointer to a Format object. Must not be nullptr.
     * @param right pointer to a Format object. Must not be nullptr.
     *
     * @return whether the two objects are the same
     * @internal
     */
    U_I18N_API static UBool equalFormats(const void* left, const void* right);
#endif  /* U_HIDE_INTERNAL_API */

private:

    Locale              fLocale;
    MessagePattern      msgPattern;
    Format**            formatAliases; // see getFormats
    int32_t             formatAliasesCapacity;

    MessageFormat() = delete; // default constructor not implemented

     /**
      * This provider helps defer instantiation of a PluralRules object
      * until we actually need to select a keyword.
      * For example, if the number matches an explicit-value selector like "=1"
      * we do not need any PluralRules.
      */
    class PluralSelectorProvider : public PluralFormat::PluralSelector {
    public:
        PluralSelectorProvider(const MessageFormat &mf, UPluralType type);
        virtual ~PluralSelectorProvider();
        virtual UnicodeString select(void *ctx, double number, UErrorCode& ec) const override;

        void reset();
    private:
        const MessageFormat &msgFormat;
        PluralRules* rules;
        UPluralType type;
    };

    /**
     * A MessageFormat formats an array of arguments.  Each argument
     * has an expected type, based on the pattern.  For example, if
     * the pattern contains the subformat "{3,number,integer}", then
     * we expect argument 3 to have type Formattable::kLong.  This
     * array needs to grow dynamically if the MessageFormat is
     * modified.
     */
    Formattable::Type* argTypes;
    int32_t            argTypeCount;
    int32_t            argTypeCapacity;

    /**
     * true if there are different argTypes for the same argument.
     * This only matters when the MessageFormat is used in the plain C (umsg_xxx) API
     * where the pattern argTypes determine how the va_arg list is read.
     */
    UBool hasArgTypeConflicts;

    // Variable-size array management
    UBool allocateArgTypes(int32_t capacity, UErrorCode& status);

    /**
     * Default Format objects used when no format is specified and a
     * numeric or date argument is formatted.  These are volatile
     * cache objects maintained only for performance.  They do not
     * participate in operator=(), copy constructor(), nor
     * operator==().
     */
    NumberFormat* defaultNumberFormat;
    DateFormat*   defaultDateFormat;

    UHashtable* cachedFormatters;
    UHashtable* customFormatArgStarts;

    PluralSelectorProvider pluralProvider;
    PluralSelectorProvider ordinalProvider;

    /**
     * Method to retrieve default formats (or nullptr on failure).
     * These are semantically const, but may modify *this.
     */
    const NumberFormat* getDefaultNumberFormat(UErrorCode&) const;
    const DateFormat*   getDefaultDateFormat(UErrorCode&) const;

    /**
     * Finds the word s, in the keyword list and returns the located index.
     * @param s the keyword to be searched for.
     * @param list the list of keywords to be searched with.
     * @return the index of the list which matches the keyword s.
     */
    static int32_t findKeyword( const UnicodeString& s,
                                const char16_t * const *list);

    /**
     * Thin wrapper around the format(... AppendableWrapper ...) variant.
     * Wraps the destination UnicodeString into an AppendableWrapper and
     * supplies default values for some other parameters.
     */
    UnicodeString& format(const Formattable* arguments,
                          const UnicodeString *argumentNames,
                          int32_t cnt,
                          UnicodeString& appendTo,
                          FieldPosition* pos,
                          UErrorCode& status) const;

    /**
     * Formats the arguments and writes the result into the
     * AppendableWrapper, updates the field position.
     *
     * @param msgStart      Index to msgPattern part to start formatting from.
     * @param plNumber      nullptr except when formatting a plural argument sub-message
     *                      where a '#' is replaced by the format string for this number.
     * @param arguments     The formattable objects array. (Must not be nullptr.)
     * @param argumentNames nullptr if numbered values are used. Otherwise the same
     *                      length as "arguments", and each entry is the name of the
     *                      corresponding argument in "arguments".
     * @param cnt           The length of arguments (and of argumentNames if that is not nullptr).
     * @param appendTo      Output parameter to receive the result.
     *                      The result string is appended to existing contents.
     * @param pos           Field position status.
     * @param success       The error code status.
     */
    void format(int32_t msgStart,
                const void *plNumber,
                const Formattable* arguments,
                const UnicodeString *argumentNames,
                int32_t cnt,
                AppendableWrapper& appendTo,
                FieldPosition* pos,
                UErrorCode& success) const;

    UnicodeString getArgName(int32_t partIndex);

    void setArgStartFormat(int32_t argStart, Format* formatter, UErrorCode& status);

    void setCustomArgStartFormat(int32_t argStart, Format* formatter, UErrorCode& status);

    int32_t nextTopLevelArgStart(int32_t partIndex) const;

    UBool argNameMatches(int32_t partIndex, const UnicodeString& argName, int32_t argNumber);

    void cacheExplicitFormats(UErrorCode& status);

    Format* createAppropriateFormat(UnicodeString& type,
                                    UnicodeString& style,
                                    Formattable::Type& formattableType,
                                    UParseError& parseError,
                                    UErrorCode& ec);

    const Formattable* getArgFromListByName(const Formattable* arguments,
                                            const UnicodeString *argumentNames,
                                            int32_t cnt, UnicodeString& name) const;

    Formattable* parse(int32_t msgStart,
                       const UnicodeString& source,
                       ParsePosition& pos,
                       int32_t& count,
                       UErrorCode& ec) const;

    FieldPosition* updateMetaData(AppendableWrapper& dest, int32_t prevLength,
                                  FieldPosition* fp, const Formattable* argId) const;

    /**
     * Finds the "other" sub-message.
     * @param partIndex the index of the first PluralFormat argument style part.
     * @return the "other" sub-message start part index.
     */
    int32_t findOtherSubMessage(int32_t partIndex) const;

    /**
     * Returns the ARG_START index of the first occurrence of the plural number in a sub-message.
     * Returns -1 if it is a REPLACE_NUMBER.
     * Returns 0 if there is neither.
     */
    int32_t findFirstPluralNumberArg(int32_t msgStart, const UnicodeString &argName) const;

    Format* getCachedFormatter(int32_t argumentNumber) const;

    UnicodeString getLiteralStringUntilNextArgument(int32_t from) const;

    void copyObjects(const MessageFormat& that, UErrorCode& ec);

    void formatComplexSubMessage(int32_t msgStart,
                                 const void *plNumber,
                                 const Formattable* arguments,
                                 const UnicodeString *argumentNames,
                                 int32_t cnt,
                                 AppendableWrapper& appendTo,
                                 UErrorCode& success) const;

    /**
     * Convenience method that ought to be in NumberFormat
     */
    NumberFormat* createIntegerFormat(const Locale& locale, UErrorCode& status) const;

    /**
     * Returns array of argument types in the parsed pattern
     * for use in C API.  Only for the use of umsg_vformat().  Not
     * for public consumption.
     * @param listCount  Output parameter to receive the size of array
     * @return           The array of formattable types in the pattern
     */
    const Formattable::Type* getArgTypeList(int32_t& listCount) const {
        listCount = argTypeCount;
        return argTypes;
    }

    /**
     * Resets the internal MessagePattern, and other associated caches.
     */
    void resetPattern();

    /**
     * A DummyFormatter that we use solely to store a nullptr value. UHash does
     * not support storing nullptr values.
     */
    class DummyFormat : public Format {
    public:
        virtual bool operator==(const Format&) const override;
        virtual DummyFormat* clone() const override;
        virtual UnicodeString& format(const Formattable& obj,
                              UnicodeString& appendTo,
                              UErrorCode& status) const;
        virtual UnicodeString& format(const Formattable&,
                                      UnicodeString& appendTo,
                                      FieldPosition&,
                                      UErrorCode& status) const override;
        virtual UnicodeString& format(const Formattable& obj,
                                      UnicodeString& appendTo,
                                      FieldPositionIterator* posIter,
                                      UErrorCode& status) const override;
        virtual void parseObject(const UnicodeString&,
                                 Formattable&,
                                 ParsePosition&) const override;
    };

    friend class MessageFormatAdapter; // getFormatTypeList() access
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _MSGFMT
//eof
