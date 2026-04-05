// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/********************************************************************
 * COPYRIGHT:
 * Copyright (c) 1997-2011, International Business Machines Corporation and
 * others. All Rights Reserved.
 * Copyright (C) 2010 , Yahoo! Inc.
 ********************************************************************
 *
 * File SELFMT.H
 *
 * Modification History:
 *
 *   Date        Name        Description
 *   11/11/09    kirtig      Finished first cut of implementation.
 ********************************************************************/

#ifndef SELFMT
#define SELFMT

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/messagepattern.h"
#include "unicode/numfmt.h"

/**
 * \file
 * \brief C++ API: SelectFormat object
 */

#if !UCONFIG_NO_FORMATTING

U_NAMESPACE_BEGIN

class MessageFormat;

/**
  * <p><code>SelectFormat</code> supports the creation of  internationalized
  * messages by selecting phrases based on keywords. The pattern  specifies
  * how to map keywords to phrases and provides a default phrase. The
  * object provided to the format method is a string that's matched
  * against the keywords. If there is a match, the corresponding phrase
  * is selected; otherwise, the default phrase is used.</p>
  *
  * <h4>Using <code>SelectFormat</code> for Gender Agreement</h4>
  *
  * <p>Note: Typically, select formatting is done via <code>MessageFormat</code>
  * with a <code>select</code> argument type,
  * rather than using a stand-alone <code>SelectFormat</code>.</p>
  *
  * <p>The main use case for the select format is gender based  inflection.
  * When names or nouns are inserted into sentences, their gender can  affect pronouns,
  * verb forms, articles, and adjectives. Special care needs to be
  * taken for the case where the gender cannot be determined.
  * The impact varies between languages:</p>
  * \htmlonly
  * <ul>
  * <li>English has three genders, and unknown gender is handled as a  special
  * case. Names use the gender of the named person (if known), nouns  referring
  * to people use natural gender, and inanimate objects are usually  neutral.
  * The gender only affects pronouns: "he", "she", "it", "they".
  *
  * <li>German differs from English in that the gender of nouns is  rather
  * arbitrary, even for nouns referring to people ("M&#x00E4;dchen", girl, is  neutral).
  * The gender affects pronouns ("er", "sie", "es"), articles ("der",  "die",
  * "das"), and adjective forms ("guter Mann", "gute Frau", "gutes  M&#x00E4;dchen").
  *
  * <li>French has only two genders; as in German the gender of nouns
  * is rather arbitrary - for sun and moon, the genders
  * are the opposite of those in German. The gender affects
  * pronouns ("il", "elle"), articles ("le", "la"),
  * adjective forms ("bon", "bonne"), and sometimes
  * verb forms ("all&#x00E9;", "all&#x00E9;e").
  *
  * <li>Polish distinguishes five genders (or noun classes),
  * human masculine, animate non-human masculine, inanimate masculine,
  * feminine, and neuter.
  * </ul>
  * \endhtmlonly
  * <p>Some other languages have noun classes that are not related to  gender,
  * but similar in grammatical use.
  * Some African languages have around 20 noun classes.</p>
  *
  * <p><b>Note:</b>For the gender of a <i>person</i> in a given sentence,
  * we usually need to distinguish only between female, male and other/unknown.</p>
  *
  * <p>To enable localizers to create sentence patterns that take their
  * language's gender dependencies into consideration, software has to  provide
  * information about the gender associated with a noun or name to
  * <code>MessageFormat</code>.
  * Two main cases can be distinguished:</p>
  *
  * <ul>
  * <li>For people, natural gender information should be maintained  for each person.
  * Keywords like "male", "female", "mixed" (for groups of people)
  * and "unknown" could be used.
  *
  * <li>For nouns, grammatical gender information should be maintained  for
  * each noun and per language, e.g., in resource bundles.
  * The keywords "masculine", "feminine", and "neuter" are commonly  used,
  * but some languages may require other keywords.
  * </ul>
  *
  * <p>The resulting keyword is provided to <code>MessageFormat</code>  as a
  * parameter separate from the name or noun it's associated with. For  example,
  * to generate a message such as "Jean went to Paris", three separate  arguments
  * would be provided: The name of the person as argument 0, the  gender of
  * the person as argument 1, and the name of the city as argument 2.
  * The sentence pattern for English, where the gender of the person has
  * no impact on this simple sentence, would not refer to argument 1  at all:</p>
  *
  * <pre>{0} went to {2}.</pre>
  *
  * <p><b>Note:</b> The entire sentence should be included (and partially repeated)
  * inside each phrase. Otherwise translators would have to be trained on how to
  * move bits of the sentence in and out of the select argument of a message.
  * (The examples below do not follow this recommendation!)</p>
  *
  * <p>The sentence pattern for French, where the gender of the person affects
  * the form of the participle, uses a select format based on argument 1:</p>
  *
  * \htmlonly<pre>{0} est {1, select, female {all&#x00E9;e} other {all&#x00E9;}} &#x00E0; {2}.</pre>\endhtmlonly
  *
  * <p>Patterns can be nested, so that it's possible to handle  interactions of
  * number and gender where necessary. For example, if the above  sentence should
  * allow for the names of several people to be inserted, the  following sentence
  * pattern can be used (with argument 0 the list of people's names,
  * argument 1 the number of people, argument 2 their combined gender, and
  * argument 3 the city name):</p>
  *
  * \htmlonly
  * <pre>{0} {1, plural,
  *                 one {est {2, select, female {all&#x00E9;e} other  {all&#x00E9;}}}
  *                 other {sont {2, select, female {all&#x00E9;es} other {all&#x00E9;s}}}
  *          }&#x00E0; {3}.</pre>
  * \endhtmlonly
  *
  * <h4>Patterns and Their Interpretation</h4>
  *
  * <p>The <code>SelectFormat</code> pattern string defines the phrase output
  * for each user-defined keyword.
  * The pattern is a sequence of (keyword, message) pairs.
  * A keyword is a "pattern identifier": [^[[:Pattern_Syntax:][:Pattern_White_Space:]]]+</p>
  *
  * <p>Each message is a MessageFormat pattern string enclosed in {curly braces}.</p>
  *
  * <p>You always have to define a phrase for the default keyword
  * <code>other</code>; this phrase is returned when the keyword
  * provided to
  * the <code>format</code> method matches no other keyword.
  * If a pattern does not provide a phrase for <code>other</code>, the  method
  * it's provided to returns the error  <code>U_DEFAULT_KEYWORD_MISSING</code>.
  * <br>
  * Pattern_White_Space between keywords and messages is ignored.
  * Pattern_White_Space within a message is preserved and output.</p>
  *
  * <p><pre>Example:
  * \htmlonly
  *
  * UErrorCode status = U_ZERO_ERROR;
  * MessageFormat *msgFmt = new MessageFormat(UnicodeString("{0} est  {1, select, female {all&#x00E9;e} other {all&#x00E9;}} &#x00E0; Paris."), Locale("fr"),  status);
  * if (U_FAILURE(status)) {
  *       return;
  * }
  * FieldPosition ignore(FieldPosition::DONT_CARE);
  * UnicodeString result;
  *
  * char* str1= "Kirti,female";
  * Formattable args1[] = {"Kirti","female"};
  * msgFmt->format(args1, 2, result, ignore, status);
  * cout << "Input is " << str1 << " and result is: " << result << endl;
  * delete msgFmt;
  *
  * \endhtmlonly
  * </pre>
  * </p>
  *
  * Produces the output:<br>
  * \htmlonly
  * <code>Kirti est all&#x00E9;e &#x00E0; Paris.</code>
  * \endhtmlonly
  *
  * @stable ICU 4.4
  */

class U_I18N_API SelectFormat : public Format {
public:

    /**
     * Creates a new <code>SelectFormat</code> for a given pattern string.
     * @param  pattern the pattern for this <code>SelectFormat</code>.
     *                 errors are returned to status if the pattern is invalid.
     * @param status   output param set to success/failure code on exit, which
     *                 must not indicate a failure before the function call.
     * @stable ICU 4.4
     */
    SelectFormat(const UnicodeString& pattern, UErrorCode& status);

    /**
     * copy constructor.
     * @stable ICU 4.4
     */
    SelectFormat(const SelectFormat& other);

    /**
     * Destructor.
     * @stable ICU 4.4
     */
    virtual ~SelectFormat();

    /**
     * Sets the pattern used by this select format.
     * for the keyword rules.
     * Patterns and their interpretation are specified in the class description.
     *
     * @param pattern the pattern for this select format
     *                errors are returned to status if the pattern is invalid.
     * @param status  output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @stable ICU 4.4
     */
    void applyPattern(const UnicodeString& pattern, UErrorCode& status);


    using Format::format;

    /**
     * Selects the phrase for  the given keyword
     *
     * @param keyword  The keyword that is used to select an alternative.
     * @param appendTo output parameter to receive result.
     *                 result is appended to existing contents.
     * @param pos      On input: an alignment field, if desired.
     *                 On output: the offsets of the alignment field.
     * @param status  output param set to success/failure code on exit, which
     *                 must not indicate a failure before the function call.
     * @return         Reference to 'appendTo' parameter.
     * @stable ICU 4.4
     */
    UnicodeString& format(const UnicodeString& keyword,
                            UnicodeString& appendTo,
                            FieldPosition& pos,
                            UErrorCode& status) const;

    /**
     * Assignment operator
     *
     * @param other    the SelectFormat object to copy from.
     * @stable ICU 4.4
     */
    SelectFormat& operator=(const SelectFormat& other);

    /**
     * Return true if another object is semantically equal to this one.
     *
     * @param other    the SelectFormat object to be compared with.
     * @return         true if other is semantically equal to this.
     * @stable ICU 4.4
     */
    virtual bool operator==(const Format& other) const override;

    /**
     * Return true if another object is semantically unequal to this one.
     *
     * @param other    the SelectFormat object to be compared with.
     * @return         true if other is semantically unequal to this.
     * @stable ICU 4.4
     */
    virtual bool operator!=(const Format& other) const;

    /**
     * Clones this Format object polymorphically.  The caller owns the
     * result and should delete it when done.
     * @stable ICU 4.4
     */
    virtual SelectFormat* clone() const override;

    /**
     * Format an object to produce a string.
     * This method handles keyword strings.
     * If the Formattable object is not a <code>UnicodeString</code>,
     * then it returns a failing UErrorCode.
     *
     * @param obj       A keyword string that is used to select an alternative.
     * @param appendTo  output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @param status    output param filled with success/failure status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 4.4
     */
    UnicodeString& format(const Formattable& obj,
                         UnicodeString& appendTo,
                         FieldPosition& pos,
                         UErrorCode& status) const override;

    /**
     * Returns the pattern from applyPattern() or constructor.
     *
     * @param  appendTo  output parameter to receive result.
     *                  Result is appended to existing contents.
     * @return the UnicodeString with inserted pattern.
     * @stable ICU 4.4
     */
    UnicodeString& toPattern(UnicodeString& appendTo);

    /**
     * This method is not yet supported by <code>SelectFormat</code>.
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
     * @param source     The string to be parsed into an object.
     * @param result     Formattable to be set to the parse result.
     *     If parse fails, return contents are undefined.
     * @param parse_pos The position to start parsing at. Upon return
     *     this param is set to the position after the
     *     last character successfully parsed. If the
     *     source is not parsed successfully, this param
     *     will remain unchanged.
     * @stable ICU 4.4
     */
    virtual void parseObject(const UnicodeString& source,
                            Formattable& result,
                            ParsePosition& parse_pos) const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     * @stable ICU 4.4
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     * @stable ICU 4.4
     */
    virtual UClassID getDynamicClassID() const override;

private:
    friend class MessageFormat;

    SelectFormat() = delete;   // default constructor not implemented.

    /**
     * Finds the SelectFormat sub-message for the given keyword, or the "other" sub-message.
     * @param pattern A MessagePattern.
     * @param partIndex the index of the first SelectFormat argument style part.
     * @param keyword a keyword to be matched to one of the SelectFormat argument's keywords.
     * @param ec Error code.
     * @return the sub-message start part index.
     */
    static int32_t findSubMessage(const MessagePattern& pattern, int32_t partIndex,
                                  const UnicodeString& keyword, UErrorCode& ec);

    MessagePattern msgPattern;
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _SELFMT
//eof
