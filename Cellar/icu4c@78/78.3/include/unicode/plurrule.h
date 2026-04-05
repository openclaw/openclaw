// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2008-2015, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*
*
* File PLURRULE.H
*
* Modification History:*
*   Date        Name        Description
*
********************************************************************************
*/

#ifndef PLURRULE
#define PLURRULE

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: PluralRules object
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/format.h"
#include "unicode/upluralrules.h"
#ifndef U_HIDE_INTERNAL_API
#include "unicode/numfmt.h"
#endif  /* U_HIDE_INTERNAL_API */

/**
 * Value returned by PluralRules::getUniqueKeywordValue() when there is no
 * unique value to return.
 * @stable ICU 4.8
 */
#define UPLRULES_NO_UNIQUE_VALUE ((double)-0.00123456777)

U_NAMESPACE_BEGIN

class Hashtable;
class IFixedDecimal;
class FixedDecimal;
class RuleChain;
class PluralRuleParser;
class PluralKeywordEnumeration;
class AndConstraint;
class SharedPluralRules;
class StandardPluralRanges;

namespace number {
class FormattedNumber;
class FormattedNumberRange;
namespace impl {
class UFormattedNumberRangeData;
class DecimalQuantity;
class DecNum;
}
}

#ifndef U_HIDE_INTERNAL_API
using icu::number::impl::DecimalQuantity;
#endif  /* U_HIDE_INTERNAL_API */

/**
 * Defines rules for mapping non-negative numeric values onto a small set of
 * keywords. Rules are constructed from a text description, consisting
 * of a series of keywords and conditions.  The {@link #select} method
 * examines each condition in order and returns the keyword for the
 * first condition that matches the number.  If none match,
 * default rule(other) is returned.
 *
 * For more information, details, and tips for writing rules, see the
 * LDML spec, Part 3.5 Language Plural Rules:
 * https://www.unicode.org/reports/tr35/tr35-numbers.html#Language_Plural_Rules
 *
 * Examples:<pre>
 *   "one: n is 1; few: n in 2..4"</pre>
 *  This defines two rules, for 'one' and 'few'.  The condition for
 *  'one' is "n is 1" which means that the number must be equal to
 *  1 for this condition to pass.  The condition for 'few' is
 *  "n in 2..4" which means that the number must be between 2 and
 *  4 inclusive for this condition to pass.  All other numbers
 *  are assigned the keyword "other" by the default rule.
 *  </p><pre>
 *    "zero: n is 0; one: n is 1; zero: n mod 100 in 1..19"</pre>
 *  This illustrates that the same keyword can be defined multiple times.
 *  Each rule is examined in order, and the first keyword whose condition
 *  passes is the one returned.  Also notes that a modulus is applied
 *  to n in the last rule.  Thus its condition holds for 119, 219, 319...
 *  </p><pre>
 *    "one: n is 1; few: n mod 10 in 2..4 and n mod 100 not in 12..14"</pre>
 *  This illustrates conjunction and negation.  The condition for 'few'
 *  has two parts, both of which must be met: "n mod 10 in 2..4" and
 *  "n mod 100 not in 12..14".  The first part applies a modulus to n
 *  before the test as in the previous example.  The second part applies
 *  a different modulus and also uses negation, thus it matches all
 *  numbers _not_ in 12, 13, 14, 112, 113, 114, 212, 213, 214...
 *  </p>
 *  <p>
 * Syntax:<pre>
 * \code
 * rules         = rule (';' rule)*
 * rule          = keyword ':' condition
 * keyword       = <identifier>
 * condition     = and_condition ('or' and_condition)*
 * and_condition = relation ('and' relation)*
 * relation      = is_relation | in_relation | within_relation | 'n' <EOL>
 * is_relation   = expr 'is' ('not')? value
 * in_relation   = expr ('not')? 'in' range_list
 * within_relation = expr ('not')? 'within' range
 * expr          = ('n' | 'i' | 'f' | 'v' | 'j') ('mod' value)?
 * range_list    = (range | value) (',' range_list)*
 * value         = digit+  ('.' digit+)?
 * digit         = 0|1|2|3|4|5|6|7|8|9
 * range         = value'..'value
 * \endcode
 * </pre></p>
 * <p>
 * <p>
 * The i, f, and v values are defined as follows:
 * </p>
 * <ul>
 * <li>i to be the integer digits.</li>
 * <li>f to be the visible fractional digits, as an integer.</li>
 * <li>v to be the number of visible fraction digits.</li>
 * <li>j is defined to only match integers. That is j is 3 fails if v != 0 (eg for 3.1 or 3.0).</li>
 * </ul>
 * <p>
 * Examples are in the following table:
 * </p>
 * <table border='1' style="border-collapse:collapse">
 * <tr>
 * <th>n</th>
 * <th>i</th>
 * <th>f</th>
 * <th>v</th>
 * </tr>
 * <tr>
 * <td>1.0</td>
 * <td>1</td>
 * <td align="right">0</td>
 * <td>1</td>
 * </tr>
 * <tr>
 * <td>1.00</td>
 * <td>1</td>
 * <td align="right">0</td>
 * <td>2</td>
 * </tr>
 * <tr>
 * <td>1.3</td>
 * <td>1</td>
 * <td align="right">3</td>
 * <td>1</td>
 * </tr>
 * <tr>
 * <td>1.03</td>
 * <td>1</td>
 * <td align="right">3</td>
 * <td>2</td>
 * </tr>
 * <tr>
 * <td>1.23</td>
 * <td>1</td>
 * <td align="right">23</td>
 * <td>2</td>
 * </tr>
 * </table>
 * <p>
 * The difference between 'in' and 'within' is that 'in' only includes integers in the specified range, while 'within'
 * includes all values. Using 'within' with a range_list consisting entirely of values is the same as using 'in' (it's
 * not an error).
 * </p>

 * An "identifier" is a sequence of characters that do not have the
 * Unicode Pattern_Syntax or Pattern_White_Space properties.
 * <p>
 * The difference between 'in' and 'within' is that 'in' only includes
 * integers in the specified range, while 'within' includes all values.
 * Using 'within' with a range_list consisting entirely of values is the
 * same as using 'in' (it's not an error).
 *</p>
 * <p>
 * Keywords
 * could be defined by users or from ICU locale data. There are 6
 * predefined values in ICU - 'zero', 'one', 'two', 'few', 'many' and
 * 'other'. Callers need to check the value of keyword returned by
 * {@link #select} method.
 * </p>
 *
 * Examples:<pre>
 * UnicodeString keyword = pl->select(number);
 * if (keyword== UnicodeString("one") {
 *     ...
 * }
 * else if ( ... )
 * </pre>
 * <strong>Note:</strong><br>
 *  <p>
 *   ICU defines plural rules for many locales based on CLDR <i>Language Plural Rules</i>.
 *   For these predefined rules, see CLDR page at
 *   https://unicode-org.github.io/cldr-staging/charts/latest/supplemental/language_plural_rules.html
 * </p>
 */
class U_I18N_API PluralRules : public UObject {
public:

    /**
     * Constructor.
     * @param status  Output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     *
     * @stable ICU 4.0
     */
    PluralRules(UErrorCode& status);

    /**
     * Copy constructor.
     * @stable ICU 4.0
     */
    PluralRules(const PluralRules& other);

    /**
     * Destructor.
     * @stable ICU 4.0
     */
    virtual ~PluralRules();

    /**
     * Clone
     * @stable ICU 4.0
     */
    PluralRules* clone() const;

    /**
      * Assignment operator.
      * @stable ICU 4.0
      */
    PluralRules& operator=(const PluralRules&);

    /**
     * Creates a PluralRules from a description if it is parsable, otherwise
     * returns nullptr.
     *
     * @param description rule description
     * @param status      Output param set to success/failure code on exit, which
     *                    must not indicate a failure before the function call.
     * @return            new PluralRules pointer. nullptr if there is an error.
     * @stable ICU 4.0
     */
    static PluralRules* U_EXPORT2 createRules(const UnicodeString& description,
                                              UErrorCode& status);

    /**
     * The default rules that accept any number.
     *
     * @param status  Output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @return        new PluralRules pointer. nullptr if there is an error.
     * @stable ICU 4.0
     */
    static PluralRules* U_EXPORT2 createDefaultRules(UErrorCode& status);

    /**
     * Provides access to the predefined cardinal-number <code>PluralRules</code> for a given
     * locale.
     * Same as forLocale(locale, UPLURAL_TYPE_CARDINAL, status).
     *
     * @param locale  The locale for which a <code>PluralRules</code> object is
     *                returned.
     * @param status  Output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @return        The predefined <code>PluralRules</code> object pointer for
     *                this locale. If there's no predefined rules for this locale,
     *                the rules for the closest parent in the locale hierarchy
     *                that has one will  be returned.  The final fallback always
     *                returns the default 'other' rules.
     * @stable ICU 4.0
     */
    static PluralRules* U_EXPORT2 forLocale(const Locale& locale, UErrorCode& status);

    /**
     * Provides access to the predefined <code>PluralRules</code> for a given
     * locale and the plural type.
     *
     * @param locale  The locale for which a <code>PluralRules</code> object is
     *                returned.
     * @param type    The plural type (e.g., cardinal or ordinal).
     * @param status  Output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @return        The predefined <code>PluralRules</code> object pointer for
     *                this locale. If there's no predefined rules for this locale,
     *                the rules for the closest parent in the locale hierarchy
     *                that has one will  be returned.  The final fallback always
     *                returns the default 'other' rules.
     * @stable ICU 50
     */
    static PluralRules* U_EXPORT2 forLocale(const Locale& locale, UPluralType type, UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Return a StringEnumeration over the locales for which there is plurals data.
     * @return a StringEnumeration over the locales available.
     * @internal
     */
    static StringEnumeration* U_EXPORT2 getAvailableLocales(UErrorCode &status);

    /**
     * For ICU use only.
     * creates a  SharedPluralRules object
     * @internal
     */
    static PluralRules* U_EXPORT2 internalForLocale(const Locale& locale, UPluralType type, UErrorCode& status);

    /**
     * For ICU use only.
     * Returns handle to the shared, cached PluralRules instance.
     * Caller must call removeRef() on returned value once it is done with
     * the shared instance.
     * @internal
     */
    static const SharedPluralRules* U_EXPORT2 createSharedInstance(
            const Locale& locale, UPluralType type, UErrorCode& status);


#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Given an integer, returns the keyword of the first rule
     * that applies to  the number.  This function can be used with
     * isKeyword* functions to determine the keyword for default plural rules.
     *
     * @param number  The number for which the rule has to be determined.
     * @return        The keyword of the selected rule.
     * @stable ICU 4.0
     */
    UnicodeString select(int32_t number) const;

    /**
     * Given a floating-point number, returns the keyword of the first rule
     * that applies to  the number.  This function can be used with
     * isKeyword* functions to determine the keyword for default plural rules.
     *
     * @param number  The number for which the rule has to be determined.
     * @return        The keyword of the selected rule.
     * @stable ICU 4.0
     */
    UnicodeString select(double number) const;

    /**
     * Given a formatted number, returns the keyword of the first rule
     * that applies to  the number.  This function can be used with
     * isKeyword* functions to determine the keyword for default plural rules.
     *
     * A FormattedNumber allows you to specify an exponent or trailing zeros,
     * which can affect the plural category. To get a FormattedNumber, see
     * NumberFormatter.
     *
     * @param number  The number for which the rule has to be determined.
     * @param status  Set if an error occurs while selecting plural keyword.
     *                This could happen if the FormattedNumber is invalid.
     * @return        The keyword of the selected rule.
     * @stable ICU 64
     */
    UnicodeString select(const number::FormattedNumber& number, UErrorCode& status) const;

    /**
     * Given a formatted number range, returns the overall plural form of the
     * range. For example, "3-5" returns "other" in English.
     *
     * To get a FormattedNumberRange, see NumberRangeFormatter.
     * 
     * This method only works if PluralRules was created with a locale. If it was created
     * from PluralRules::createRules(), this method sets status code U_UNSUPPORTED_ERROR.
     * 
     * @param range  The number range onto which the rules will be applied.
     * @param status Set if an error occurs while selecting plural keyword.
     *               This could happen if the FormattedNumberRange is invalid,
     *               or if plural ranges data is unavailable.
     * @return       The keyword of the selected rule.
     * @stable ICU 68
     */
    UnicodeString select(const number::FormattedNumberRange& range, UErrorCode& status) const;

#ifndef U_HIDE_INTERNAL_API
    /**
     * @internal
     */
    UnicodeString select(const IFixedDecimal &number) const;
    /**
     * @internal
     */
    UnicodeString select(const number::impl::UFormattedNumberRangeData* urange, UErrorCode& status) const;
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Returns a list of all rule keywords used in this <code>PluralRules</code>
     * object.  The rule 'other' is always present by default.
     *
     * @param status Output param set to success/failure code on exit, which
     *               must not indicate a failure before the function call.
     * @return       StringEnumeration with the keywords.
     *               The caller must delete the object.
     * @stable ICU 4.0
     */
    StringEnumeration* getKeywords(UErrorCode& status) const;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Deprecated Function, does not return useful results.
     *
     * Originally intended to return a unique value for this keyword if it exists,
     * else the constant UPLRULES_NO_UNIQUE_VALUE.
     *
     * @param keyword The keyword.
     * @return        Stub deprecated function returns UPLRULES_NO_UNIQUE_VALUE always.
     * @deprecated ICU 55
     */
    double getUniqueKeywordValue(const UnicodeString& keyword);

    /**
     * Deprecated Function, does not produce useful results.
     *
     * Originally intended to return all the values for which select() would return the keyword.
     * If the keyword is unknown, returns no values, but this is not an error.  If
     * the number of values is unlimited, returns no values and -1 as the
     * count.
     *
     * The number of returned values is typically small.
     *
     * @param keyword      The keyword.
     * @param dest         Array into which to put the returned values.  May
     *                     be nullptr if destCapacity is 0.
     * @param destCapacity The capacity of the array, must be at least 0.
     * @param status       The error code. Deprecated function, always sets U_UNSUPPORTED_ERROR.
     * @return             The count of values available, or -1.  This count
     *                     can be larger than destCapacity, but no more than
     *                     destCapacity values will be written.
     * @deprecated ICU 55
     */
    int32_t getAllKeywordValues(const UnicodeString &keyword,
                                double *dest, int32_t destCapacity,
                                UErrorCode& status);
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Returns sample values for which select() would return the keyword.  If
     * the keyword is unknown, returns no values, but this is not an error.
     *
     * The number of returned values is typically small.
     *
     * @param keyword      The keyword.
     * @param dest         Array into which to put the returned values.  May
     *                     be nullptr if destCapacity is 0.
     * @param destCapacity The capacity of the array, must be at least 0.
     * @param status       The error code.
     * @return             The count of values written.
     *                     If more than destCapacity samples are available, then
     *                     only destCapacity are written, and destCapacity is returned as the count,
     *                     rather than setting a U_BUFFER_OVERFLOW_ERROR.
     *                     (The actual number of keyword values could be unlimited.)
     * @stable ICU 4.8
     */
    int32_t getSamples(const UnicodeString &keyword,
                       double *dest, int32_t destCapacity,
                       UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Internal-only function that returns DecimalQuantitys instead of doubles.
     *
     * Returns sample values for which select() would return the keyword.  If
     * the keyword is unknown, returns no values, but this is not an error.
     *
     * The number of returned values is typically small.
     *
     * @param keyword      The keyword.
     * @param dest         Array into which to put the returned values.  May
     *                     be nullptr if destCapacity is 0.
     * @param destCapacity The capacity of the array, must be at least 0.
     * @param status       The error code.
     * @return             The count of values written.
     *                     If more than destCapacity samples are available, then
     *                     only destCapacity are written, and destCapacity is returned as the count,
     *                     rather than setting a U_BUFFER_OVERFLOW_ERROR.
     *                     (The actual number of keyword values could be unlimited.)
     * @internal
     */
    int32_t getSamples(const UnicodeString &keyword,
                       DecimalQuantity *dest, int32_t destCapacity,
                       UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Returns true if the given keyword is defined in this
     * <code>PluralRules</code> object.
     *
     * @param keyword  the input keyword.
     * @return         true if the input keyword is defined.
     *                 Otherwise, return false.
     * @stable ICU 4.0
     */
    UBool isKeyword(const UnicodeString& keyword) const;


    /**
     * Returns keyword for default plural form.
     *
     * @return         keyword for default plural form.
     * @stable ICU 4.0
     */
    UnicodeString getKeywordOther() const;

#ifndef U_HIDE_INTERNAL_API
    /**
     *
     * @internal
     */
     UnicodeString getRules() const;
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Compares the equality of two PluralRules objects.
     *
     * @param other The other PluralRules object to be compared with.
     * @return      true if the given PluralRules is the same as this
     *              PluralRules; false otherwise.
     * @stable ICU 4.0
     */
    virtual bool operator==(const PluralRules& other) const;

    /**
     * Compares the inequality of two PluralRules objects.
     *
     * @param other The PluralRules object to be compared with.
     * @return      true if the given PluralRules is not the same as this
     *              PluralRules; false otherwise.
     * @stable ICU 4.0
     */
    bool operator!=(const PluralRules& other) const  {return !operator==(other);}


    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 4.0
     *
    */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 4.0
     */
    virtual UClassID getDynamicClassID() const override;


private:
    RuleChain  *mRules;
    StandardPluralRanges *mStandardPluralRanges;

    PluralRules() = delete;   // default constructor not implemented
    UnicodeString   getRuleFromResource(const Locale& locale, UPluralType type, UErrorCode& status);
    RuleChain      *rulesForKeyword(const UnicodeString &keyword) const;
    PluralRules    *clone(UErrorCode& status) const;

    /**
    * An internal status variable used to indicate that the object is in an 'invalid' state.
    * Used by copy constructor, the assignment operator and the clone method.
    */
    UErrorCode mInternalStatus;

    friend class PluralRuleParser;
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _PLURRULE
//eof
