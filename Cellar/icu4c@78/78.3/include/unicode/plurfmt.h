// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2007-2014, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*

* File PLURFMT.H
********************************************************************************
*/

#ifndef PLURFMT
#define PLURFMT

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: PluralFormat object
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/messagepattern.h"
#include "unicode/numfmt.h"
#include "unicode/plurrule.h"

U_NAMESPACE_BEGIN

class Hashtable;
class NFRule;

/**
 * <p>
 * <code>PluralFormat</code> supports the creation of internationalized
 * messages with plural inflection. It is based on <i>plural
 * selection</i>, i.e. the caller specifies messages for each
 * plural case that can appear in the user's language and the
 * <code>PluralFormat</code> selects the appropriate message based on
 * the number.
 * </p>
 * <h4>The Problem of Plural Forms in Internationalized Messages</h4>
 * <p>
 * Different languages have different ways to inflect
 * plurals. Creating internationalized messages that include plural
 * forms is only feasible when the framework is able to handle plural
 * forms of <i>all</i> languages correctly. <code>ChoiceFormat</code>
 * doesn't handle this well, because it attaches a number interval to
 * each message and selects the message whose interval contains a
 * given number. This can only handle a finite number of
 * intervals. But in some languages, like Polish, one plural case
 * applies to infinitely many intervals (e.g., the plural case applies to
 * numbers ending with 2, 3, or 4 except those ending with 12, 13, or
 * 14). Thus <code>ChoiceFormat</code> is not adequate.
 * </p><p>
 * <code>PluralFormat</code> deals with this by breaking the problem
 * into two parts:
 * <ul>
 * <li>It uses <code>PluralRules</code> that can define more complex
 *     conditions for a plural case than just a single interval. These plural
 *     rules define both what plural cases exist in a language, and to
 *     which numbers these cases apply.
 * <li>It provides predefined plural rules for many languages. Thus, the programmer
 *     need not worry about the plural cases of a language and
 *     does not have to define the plural cases; they can simply
 *     use the predefined keywords. The whole plural formatting of messages can
 *     be done using localized patterns from resource bundles. For predefined plural
 *     rules, see the CLDR <i>Language Plural Rules</i> page at
 *     https://unicode-org.github.io/cldr-staging/charts/latest/supplemental/language_plural_rules.html
 * </ul>
 * </p>
 * <h4>Usage of <code>PluralFormat</code></h4>
 * <p>Note: Typically, plural formatting is done via <code>MessageFormat</code>
 * with a <code>plural</code> argument type,
 * rather than using a stand-alone <code>PluralFormat</code>.
 * </p><p>
 * This discussion assumes that you use <code>PluralFormat</code> with
 * a predefined set of plural rules. You can create one using one of
 * the constructors that takes a <code>locale</code> object. To
 * specify the message pattern, you can either pass it to the
 * constructor or set it explicitly using the
 * <code>applyPattern()</code> method. The <code>format()</code>
 * method takes a number object and selects the message of the
 * matching plural case. This message will be returned.
 * </p>
 * <h5>Patterns and Their Interpretation</h5>
 * <p>
 * The pattern text defines the message output for each plural case of the
 * specified locale. Syntax:
 * <pre>
 * pluralStyle = [offsetValue] (selector '{' message '}')+
 * offsetValue = "offset:" number
 * selector = explicitValue | keyword
 * explicitValue = '=' number  // adjacent, no white space in between
 * keyword = [^[[:Pattern_Syntax:][:Pattern_White_Space:]]]+
 * message: see {@link MessageFormat}
 * </pre>
 * Pattern_White_Space between syntax elements is ignored, except
 * between the {curly braces} and their sub-message,
 * and between the '=' and the number of an explicitValue.
 *
 * </p><p>
 * There are 6 predefined casekeyword in CLDR/ICU - 'zero', 'one', 'two', 'few', 'many' and
 * 'other'. You always have to define a message text for the default plural case
 * <code>other</code> which is contained in every rule set.
 * If you do not specify a message text for a particular plural case, the
 * message text of the plural case <code>other</code> gets assigned to this
 * plural case.
 * </p><p>
 * When formatting, the input number is first matched against the explicitValue clauses.
 * If there is no exact-number match, then a keyword is selected by calling
 * the <code>PluralRules</code> with the input number <em>minus the offset</em>.
 * (The offset defaults to 0 if it is omitted from the pattern string.)
 * If there is no clause with that keyword, then the "other" clauses is returned.
 * </p><p>
 * An unquoted pound sign (<code>#</code>) in the selected sub-message
 * itself (i.e., outside of arguments nested in the sub-message)
 * is replaced by the input number minus the offset.
 * The number-minus-offset value is formatted using a
 * <code>NumberFormat</code> for the <code>PluralFormat</code>'s locale. If you
 * need special number formatting, you have to use a <code>MessageFormat</code>
 * and explicitly specify a <code>NumberFormat</code> argument.
 * <strong>Note:</strong> That argument is formatting without subtracting the offset!
 * If you need a custom format and have a non-zero offset, then you need to pass the
 * number-minus-offset value as a separate parameter.
 * </p>
 * For a usage example, see the {@link MessageFormat} class documentation.
 *
 * <h4>Defining Custom Plural Rules</h4>
 * <p>If you need to use <code>PluralFormat</code> with custom rules, you can
 * create a <code>PluralRules</code> object and pass it to
 * <code>PluralFormat</code>'s constructor. If you also specify a locale in this
 * constructor, this locale will be used to format the number in the message
 * texts.
 * </p><p>
 * For more information about <code>PluralRules</code>, see
 * {@link PluralRules}.
 * </p>
 *
 * ported from Java
 * @stable ICU 4.0
 */

class U_I18N_API_CLASS PluralFormat : public Format {
public:

    /**
     * Creates a new cardinal-number <code>PluralFormat</code> for the default locale.
     * This locale will be used to get the set of plural rules and for standard
     * number formatting.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(UErrorCode& status);

    /**
     * Creates a new cardinal-number <code>PluralFormat</code> for a given locale.
     * @param locale the <code>PluralFormat</code> will be configured with
     *               rules for this locale. This locale will also be used for
     *               standard number formatting.
     * @param status output param set to success/failure code on exit, which
     *               must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(const Locale& locale, UErrorCode& status);

    /**
     * Creates a new <code>PluralFormat</code> for a given set of rules.
     * The standard number formatting will be done using the default locale.
     * @param rules   defines the behavior of the <code>PluralFormat</code>
     *                object.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(const PluralRules& rules, UErrorCode& status);

    /**
     * Creates a new <code>PluralFormat</code> for a given set of rules.
     * The standard number formatting will be done using the given locale.
     * @param locale  the default number formatting will be done using this
     *                locale.
     * @param rules   defines the behavior of the <code>PluralFormat</code>
     *                object.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(const Locale& locale, const PluralRules& rules, UErrorCode& status);

    /**
     * Creates a new <code>PluralFormat</code> for the plural type.
     * The standard number formatting will be done using the given locale.
     * @param locale  the default number formatting will be done using this
     *                locale.
     * @param type    The plural type (e.g., cardinal or ordinal).
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 50
     */
    U_I18N_API PluralFormat(const Locale& locale, UPluralType type, UErrorCode& status);

    /**
     * Creates a new cardinal-number <code>PluralFormat</code> for a given pattern string.
     * The default locale will be used to get the set of plural rules and for
     * standard number formatting.
     * @param  pattern the pattern for this <code>PluralFormat</code>.
     *                 errors are returned to status if the pattern is invalid.
     * @param status   output param set to success/failure code on exit, which
     *                 must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(const UnicodeString& pattern, UErrorCode& status);

    /**
     * Creates a new cardinal-number <code>PluralFormat</code> for a given pattern string and
     * locale.
     * The locale will be used to get the set of plural rules and for
     * standard number formatting.
     * @param locale   the <code>PluralFormat</code> will be configured with
     *                 rules for this locale. This locale will also be used for
     *                 standard number formatting.
     * @param pattern  the pattern for this <code>PluralFormat</code>.
     *                 errors are returned to status if the pattern is invalid.
     * @param status   output param set to success/failure code on exit, which
     *                 must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(const Locale& locale, const UnicodeString& pattern, UErrorCode& status);

    /**
     * Creates a new <code>PluralFormat</code> for a given set of rules, a
     * pattern and a locale.
     * @param rules    defines the behavior of the <code>PluralFormat</code>
     *                 object.
     * @param pattern  the pattern for this <code>PluralFormat</code>.
     *                 errors are returned to status if the pattern is invalid.
     * @param status   output param set to success/failure code on exit, which
     *                 must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(const PluralRules& rules, const UnicodeString& pattern, UErrorCode& status);

    /**
     * Creates a new <code>PluralFormat</code> for a given set of rules, a
     * pattern and a locale.
     * @param locale  the <code>PluralFormat</code> will be configured with
     *                rules for this locale. This locale will also be used for
     *                standard number formatting.
     * @param rules   defines the behavior of the <code>PluralFormat</code>
     *                object.
     * @param pattern the pattern for this <code>PluralFormat</code>.
     *                errors are returned to status if the pattern is invalid.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API PluralFormat(const Locale& locale,
                            const PluralRules& rules,
                            const UnicodeString& pattern,
                            UErrorCode& status);

    /**
     * Creates a new <code>PluralFormat</code> for a plural type, a
     * pattern and a locale.
     * @param locale  the <code>PluralFormat</code> will be configured with
     *                rules for this locale. This locale will also be used for
     *                standard number formatting.
     * @param type    The plural type (e.g., cardinal or ordinal).
     * @param pattern the pattern for this <code>PluralFormat</code>.
     *                errors are returned to status if the pattern is invalid.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 50
     */
    U_I18N_API PluralFormat(const Locale& locale,
                            UPluralType type,
                            const UnicodeString& pattern,
                            UErrorCode& status);

    /**
      * copy constructor.
      * @stable ICU 4.0
      */
    U_I18N_API PluralFormat(const PluralFormat& other);

    /**
     * Destructor.
     * @stable ICU 4.0
     */
    U_I18N_API virtual ~PluralFormat();

    /**
     * Sets the pattern used by this plural format.
     * The method parses the pattern and creates a map of format strings
     * for the plural rules.
     * Patterns and their interpretation are specified in the class description.
     *
     * @param pattern the pattern for this plural format
     *                errors are returned to status if the pattern is invalid.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 4.0
     */
    U_I18N_API void applyPattern(const UnicodeString& pattern, UErrorCode& status);

    using Format::format;

    /**
     * Formats a plural message for a given number.
     *
     * @param number  a number for which the plural message should be formatted
     *                for. If no pattern has been applied to this
     *                <code>PluralFormat</code> object yet, the formatted number
     *                will be returned.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @return        the string containing the formatted plural message.
     * @stable ICU 4.0
     */
    U_I18N_API UnicodeString format(int32_t number, UErrorCode& status) const;

    /**
     * Formats a plural message for a given number.
     *
     * @param number  a number for which the plural message should be formatted
     *                for. If no pattern has been applied to this
     *                PluralFormat object yet, the formatted number
     *                will be returned.
     * @param status  output param set to success or failure code on exit, which
     *                must not indicate a failure before the function call.
     * @return        the string containing the formatted plural message.
     * @stable ICU 4.0
     */
    U_I18N_API UnicodeString format(double number, UErrorCode& status) const;

    /**
     * Formats a plural message for a given number.
     *
     * @param number   a number for which the plural message should be formatted
     *                 for. If no pattern has been applied to this
     *                 <code>PluralFormat</code> object yet, the formatted number
     *                 will be returned.
     * @param appendTo output parameter to receive result.
     *                 result is appended to existing contents.
     * @param pos      On input: an alignment field, if desired.
     *                 On output: the offsets of the alignment field.
     * @param status   output param set to success/failure code on exit, which
     *                 must not indicate a failure before the function call.
     * @return         the string containing the formatted plural message.
     * @stable ICU 4.0
     */
    U_I18N_API UnicodeString& format(int32_t number,
                                     UnicodeString& appendTo,
                                     FieldPosition& pos,
                                     UErrorCode& status) const;

    /**
     * Formats a plural message for a given number.
     *
     * @param number   a number for which the plural message should be formatted
     *                 for. If no pattern has been applied to this
     *                 PluralFormat object yet, the formatted number
     *                 will be returned.
     * @param appendTo output parameter to receive result.
     *                 result is appended to existing contents.
     * @param pos      On input: an alignment field, if desired.
     *                 On output: the offsets of the alignment field.
     * @param status   output param set to success/failure code on exit, which
     *                 must not indicate a failure before the function call.
     * @return         the string containing the formatted plural message.
     * @stable ICU 4.0
     */
    U_I18N_API UnicodeString& format(double number,
                                     UnicodeString& appendTo,
                                     FieldPosition& pos,
                                     UErrorCode& status) const;

#ifndef U_HIDE_DEPRECATED_API 
    /**
     * Sets the locale used by this <code>PluraFormat</code> object.
     * Note: Calling this method resets this <code>PluraFormat</code> object,
     *     i.e., a pattern that was applied previously will be removed,
     *     and the NumberFormat is set to the default number format for
     *     the locale.  The resulting format behaves the same as one
     *     constructed from {@link #PluralFormat(const Locale& locale, UPluralType type, UErrorCode& status)}
     *     with UPLURAL_TYPE_CARDINAL.
     * @param locale  the <code>locale</code> to use to configure the formatter.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @deprecated ICU 50 This method clears the pattern and might create
     *             a different kind of PluralRules instance;
     *             use one of the constructors to create a new instance instead.
     */
    U_I18N_API void setLocale(const Locale& locale, UErrorCode& status);
#endif  /* U_HIDE_DEPRECATED_API */

    /**
      * Sets the number format used by this formatter.  You only need to
      * call this if you want a different number format than the default
      * formatter for the locale.
      * @param format  the number format to use.
      * @param status  output param set to success/failure code on exit, which
      *                must not indicate a failure before the function call.
      * @stable ICU 4.0
      */
    U_I18N_API void setNumberFormat(const NumberFormat* format, UErrorCode& status);

    /**
       * Assignment operator
       *
       * @param other    the PluralFormat object to copy from.
       * @stable ICU 4.0
       */
    U_I18N_API PluralFormat& operator=(const PluralFormat& other);

    /**
      * Return true if another object is semantically equal to this one.
      *
      * @param other    the PluralFormat object to be compared with.
      * @return         true if other is semantically equal to this.
      * @stable ICU 4.0
      */
    U_I18N_API virtual bool operator==(const Format& other) const override;

    /**
     * Return true if another object is semantically unequal to this one.
     *
     * @param other    the PluralFormat object to be compared with.
     * @return         true if other is semantically unequal to this.
     * @stable ICU 4.0
     */
    U_I18N_API virtual bool operator!=(const Format& other) const;

    /**
     * Clones this Format object polymorphically.  The caller owns the
     * result and should delete it when done.
     * @stable ICU 4.0
     */
    U_I18N_API virtual PluralFormat* clone() const override;

    /**
     * Formats a plural message for a number taken from a Formattable object.
     *
     * @param obj       The object containing a number for which the
     *                  plural message should be formatted.
     *                  The object must be of a numeric type.
     * @param appendTo  output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @param status    output param filled with success/failure status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 4.0
     */
    U_I18N_API UnicodeString& format(const Formattable& obj,
                                     UnicodeString& appendTo,
                                     FieldPosition& pos,
                                     UErrorCode& status) const override;

    /**
     * Returns the pattern from applyPattern() or constructor().
     *
     * @param  appendTo  output parameter to receive result.
     *                  Result is appended to existing contents.
     * @return the UnicodeString with inserted pattern.
     * @stable ICU 4.0
     */
    U_I18N_API UnicodeString& toPattern(UnicodeString& appendTo);

    /**
     * This method is not yet supported by <code>PluralFormat</code>.
     * <P>
     * Before calling, set parse_pos.index to the offset you want to start
     * parsing at in the source. After calling, parse_pos.index is the end of
     * the text you parsed. If error occurs, index is unchanged.
     * <P>
     * When parsing, leading whitespace is discarded (with a successful parse),
     * while trailing whitespace is left as is.
     * <P>
     * See Format::parseObject() for more.
     *
     * @param source    The string to be parsed into an object.
     * @param result    Formattable to be set to the parse result.
     *                  If parse fails, return contents are undefined.
     * @param parse_pos The position to start parsing at. Upon return
     *                  this param is set to the position after the
     *                  last character successfully parsed. If the
     *                  source is not parsed successfully, this param
     *                  will remain unchanged.
     * @stable ICU 4.0
     */
    U_I18N_API virtual void parseObject(const UnicodeString& source,
                                        Formattable& result,
                                        ParsePosition& parse_pos) const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 4.0
     *
     */
    U_I18N_API static UClassID getStaticClassID();

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 4.0
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override;

private:
    class PluralSelector : public UMemory {
      public:
        virtual ~PluralSelector();
        /**
         * Given a number, returns the appropriate PluralFormat keyword.
         *
         * @param context worker object for the selector.
         * @param number The number to be plural-formatted.
         * @param ec Error code.
         * @return The selected PluralFormat keyword.
         */
        virtual UnicodeString select(void *context, double number, UErrorCode& ec) const = 0;
    };

    class PluralSelectorAdapter : public PluralSelector {
      public:
        PluralSelectorAdapter() : pluralRules(nullptr) {
        }

        virtual ~PluralSelectorAdapter();

        virtual UnicodeString select(void *context, double number, UErrorCode& /*ec*/) const override;

        void reset();

        PluralRules* pluralRules;
    };

    Locale  locale;
    MessagePattern msgPattern;
    NumberFormat*  numberFormat;
    double offset;
    PluralSelectorAdapter pluralRulesWrapper;

    PluralFormat() = delete;   // default constructor not implemented
    void init(const PluralRules* rules, UPluralType type, UErrorCode& status);
    /**
     * Copies dynamically allocated values (pointer fields).
     * Others are copied using their copy constructors and assignment operators.
     */
    void copyObjects(const PluralFormat& other);

    UnicodeString& format(const Formattable& numberObject, double number,
                          UnicodeString& appendTo,
                          FieldPosition& pos,
                          UErrorCode& status) const;

    /**
     * Finds the PluralFormat sub-message for the given number, or the "other" sub-message.
     * @param pattern A MessagePattern.
     * @param partIndex the index of the first PluralFormat argument style part.
     * @param selector the PluralSelector for mapping the number (minus offset) to a keyword.
     * @param context worker object for the selector.
     * @param number a number to be matched to one of the PluralFormat argument's explicit values,
     *        or mapped via the PluralSelector.
     * @param ec ICU error code.
     * @return the sub-message start part index.
     */
    static int32_t findSubMessage(
         const MessagePattern& pattern, int32_t partIndex,
         const PluralSelector& selector, void *context, double number, UErrorCode& ec);

    void parseType(const UnicodeString& source, const NFRule *rbnfLenientScanner,
        Formattable& result, FieldPosition& pos) const;

    friend class MessageFormat;
    friend class NFRule;
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _PLURFMT
//eof
