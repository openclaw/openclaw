// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
*   Copyright (C) 1997-2013, International Business Machines
*   Corporation and others.  All Rights Reserved.
********************************************************************************
*
* File CHOICFMT.H
*
* Modification History:
*
*   Date        Name        Description
*   02/19/97    aliu        Converted from java.
*   03/20/97    helena      Finished first cut of implementation and got rid
*                           of nextDouble/previousDouble and replaced with
*                           boolean array.
*   4/10/97     aliu        Clean up.  Modified to work on AIX.
*   8/6/97      nos         Removed overloaded constructor, member var 'buffer'.
*   07/22/98    stephen     Removed operator!= (implemented in Format)
********************************************************************************
*/

#ifndef CHOICFMT_H
#define CHOICFMT_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Choice Format.
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/fieldpos.h"
#include "unicode/format.h"
#include "unicode/messagepattern.h"
#include "unicode/numfmt.h"
#include "unicode/unistr.h"

#ifndef U_HIDE_DEPRECATED_API

U_NAMESPACE_BEGIN

class MessageFormat;

/**
 * ChoiceFormat converts between ranges of numeric values and strings for those ranges.
 * The strings must conform to the MessageFormat pattern syntax.
 *
 * <p><em><code>ChoiceFormat</code> is probably not what you need.
 * Please use <code>MessageFormat</code>
 * with <code>plural</code> arguments for proper plural selection,
 * and <code>select</code> arguments for simple selection among a fixed set of choices!</em></p>
 *
 * <p>A <code>ChoiceFormat</code> splits
 * the real number line \htmlonly<code>-&#x221E;</code> to
 * <code>+&#x221E;</code>\endhtmlonly into two
 * or more contiguous ranges. Each range is mapped to a
 * string.</p>
 *
 * <p><code>ChoiceFormat</code> was originally intended
 * for displaying grammatically correct
 * plurals such as &quot;There is one file.&quot; vs. &quot;There are 2 files.&quot;
 * <em>However,</em> plural rules for many languages
 * are too complex for the capabilities of ChoiceFormat,
 * and its requirement of specifying the precise rules for each message
 * is unmanageable for translators.</p>
 *
 * <p>There are two methods of defining a <code>ChoiceFormat</code>; both
 * are equivalent.  The first is by using a string pattern. This is the
 * preferred method in most cases.  The second method is through direct
 * specification of the arrays that logically make up the
 * <code>ChoiceFormat</code>.</p>
 *
 * <p>Note: Typically, choice formatting is done (if done at all) via <code>MessageFormat</code>
 * with a <code>choice</code> argument type,
 * rather than using a stand-alone <code>ChoiceFormat</code>.</p>
 *
 * <h5>Patterns and Their Interpretation</h5>
 *
 * <p>The pattern string defines the range boundaries and the strings for each number range.
 * Syntax:
 * <pre>
 * choiceStyle = number separator message ('|' number separator message)*
 * number = normal_number | ['-'] \htmlonly&#x221E;\endhtmlonly (U+221E, infinity)
 * normal_number = double value (unlocalized ASCII string)
 * separator = less_than | less_than_or_equal
 * less_than = '<'
 * less_than_or_equal = '#' | \htmlonly&#x2264;\endhtmlonly (U+2264)
 * message: see {@link MessageFormat}
 * </pre>
 * Pattern_White_Space between syntax elements is ignored, except
 * around each range's sub-message.</p>
 *
 * <p>Each numeric sub-range extends from the current range's number
 * to the next range's number.
 * The number itself is included in its range if a <code>less_than_or_equal</code> sign is used,
 * and excluded from its range (and instead included in the previous range)
 * if a <code>less_than</code> sign is used.</p>
 *
 * <p>When a <code>ChoiceFormat</code> is constructed from
 * arrays of numbers, closure flags and strings,
 * they are interpreted just like
 * the sequence of <code>(number separator string)</code> in an equivalent pattern string.
 * <code>closure[i]==true</code> corresponds to a <code>less_than</code> separator sign.
 * The equivalent pattern string will be constructed automatically.</p>
 *
 * <p>During formatting, a number is mapped to the first range
 * where the number is not greater than the range's upper limit.
 * That range's message string is returned. A NaN maps to the very first range.</p>
 *
 * <p>During parsing, a range is selected for the longest match of
 * any range's message. That range's number is returned, ignoring the separator/closure.
 * Only a simple string match is performed, without parsing of arguments that
 * might be specified in the message strings.</p>
 *
 * <p>Note that the first range's number is ignored in formatting
 * but may be returned from parsing.</p>
 *
 * <h5>Examples</h5>
 *
 * <p>Here is an example of two arrays that map the number
 * <code>1..7</code> to the English day of the week abbreviations
 * <code>Sun..Sat</code>. No closures array is given; this is the same as
 * specifying all closures to be <code>false</code>.</p>
 *
 * <pre>    {1,2,3,4,5,6,7},
 *     {&quot;Sun&quot;,&quot;Mon&quot;,&quot;Tue&quot;,&quot;Wed&quot;,&quot;Thur&quot;,&quot;Fri&quot;,&quot;Sat&quot;}</pre>
 *
 * <p>Here is an example that maps the ranges [-Inf, 1), [1, 1], and (1,
 * +Inf] to three strings. That is, the number line is split into three
 * ranges: x &lt; 1.0, x = 1.0, and x &gt; 1.0.
 * (The round parentheses in the notation above indicate an exclusive boundary,
 * like the turned bracket in European notation: [-Inf, 1) == [-Inf, 1[  )</p>
 *
 * <pre>    {0, 1, 1},
 *     {false, false, true},
 *     {&quot;no files&quot;, &quot;one file&quot;, &quot;many files&quot;}</pre>
 *
 * <p>Here is an example that shows formatting and parsing: </p>
 *
 * \code
 *   #include <unicode/choicfmt.h>
 *   #include <unicode/unistr.h>
 *   #include <iostream.h>
 *
 *   int main(int argc, char *argv[]) {
 *       double limits[] = {1,2,3,4,5,6,7};
 *       UnicodeString monthNames[] = {
 *           "Sun","Mon","Tue","Wed","Thu","Fri","Sat"};
 *       ChoiceFormat fmt(limits, monthNames, 7);
 *       UnicodeString str;
 *       char buf[256];
 *       for (double x = 1.0; x <= 8.0; x += 1.0) {
 *           fmt.format(x, str);
 *           str.extract(0, str.length(), buf, 256, "");
 *           str.truncate(0);
 *           cout << x << " -> "
 *                << buf << endl;
 *       }
 *       cout << endl;
 *       return 0;
 *   }
 * \endcode
 *
 * <p><em>User subclasses are not supported.</em> While clients may write
 * subclasses, such code will not necessarily work and will not be
 * guaranteed to work stably from release to release.
 *
 * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
 */
class U_I18N_API ChoiceFormat: public NumberFormat {
public:
    /**
     * Constructs a new ChoiceFormat from the pattern string.
     *
     * @param pattern   Pattern used to construct object.
     * @param status    Output param to receive success code.  If the
     *                  pattern cannot be parsed, set to failure code.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    ChoiceFormat(const UnicodeString& pattern,
                 UErrorCode& status);


    /**
     * Constructs a new ChoiceFormat with the given limits and message strings.
     * All closure flags default to <code>false</code>,
     * equivalent to <code>less_than_or_equal</code> separators.
     *
     * Copies the limits and formats instead of adopting them.
     *
     * @param limits    Array of limit values.
     * @param formats   Array of formats.
     * @param count     Size of 'limits' and 'formats' arrays.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    ChoiceFormat(const double* limits,
                 const UnicodeString* formats,
                 int32_t count );

    /**
     * Constructs a new ChoiceFormat with the given limits, closure flags and message strings.
     *
     * Copies the limits and formats instead of adopting them.
     *
     * @param limits Array of limit values
     * @param closures Array of booleans specifying whether each
     * element of 'limits' is open or closed.  If false, then the
     * corresponding limit number is a member of its range.
     * If true, then the limit number belongs to the previous range it.
     * @param formats Array of formats
     * @param count Size of 'limits', 'closures', and 'formats' arrays
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    ChoiceFormat(const double* limits,
                 const UBool* closures,
                 const UnicodeString* formats,
                 int32_t count);

    /**
     * Copy constructor.
     *
     * @param that   ChoiceFormat object to be copied from
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    ChoiceFormat(const ChoiceFormat& that);

    /**
     * Assignment operator.
     *
     * @param that   ChoiceFormat object to be copied
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    const ChoiceFormat& operator=(const ChoiceFormat& that);

    /**
     * Destructor.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual ~ChoiceFormat();

    /**
     * Clones this Format object. The caller owns the
     * result and must delete it when done.
     *
     * @return a copy of this object
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual ChoiceFormat* clone() const override;

    /**
     * Returns true if the given Format objects are semantically equal.
     * Objects of different subclasses are considered unequal.
     *
     * @param other    ChoiceFormat object to be compared
     * @return         true if other is the same as this.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual bool operator==(const Format& other) const override;

    /**
     * Sets the pattern.
     * @param pattern   The pattern to be applied.
     * @param status    Output param set to success/failure code on
     *                  exit. If the pattern is invalid, this will be
     *                  set to a failure result.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual void applyPattern(const UnicodeString& pattern,
                              UErrorCode& status);

    /**
     * Sets the pattern.
     * @param pattern    The pattern to be applied.
     * @param parseError Struct to receive information on position
     *                   of error if an error is encountered
     * @param status     Output param set to success/failure code on
     *                   exit. If the pattern is invalid, this will be
     *                   set to a failure result.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual void applyPattern(const UnicodeString& pattern,
                             UParseError& parseError,
                             UErrorCode& status);
    /**
     * Gets the pattern.
     *
     * @param pattern    Output param which will receive the pattern
     *                   Previous contents are deleted.
     * @return    A reference to 'pattern'
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual UnicodeString& toPattern(UnicodeString &pattern) const;

    /**
     * Sets the choices to be used in formatting.
     * For details see the constructor with the same parameter list.
     *
     * @param limitsToCopy      Contains the top value that you want
     *                          parsed with that format,and should be in
     *                          ascending sorted order. When formatting X,
     *                          the choice will be the i, where limit[i]
     *                          &lt;= X &lt; limit[i+1].
     * @param formatsToCopy     The format strings you want to use for each limit.
     * @param count             The size of the above arrays.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual void setChoices(const double* limitsToCopy,
                            const UnicodeString* formatsToCopy,
                            int32_t count );

    /**
     * Sets the choices to be used in formatting.
     * For details see the constructor with the same parameter list.
     *
     * @param limits Array of limits
     * @param closures Array of limit booleans
     * @param formats Array of format string
     * @param count The size of the above arrays
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual void setChoices(const double* limits,
                            const UBool* closures,
                            const UnicodeString* formats,
                            int32_t count);

    /**
     * Returns nullptr and 0.
     * Before ICU 4.8, this used to return the choice limits array.
     *
     * @param count Will be set to 0.
     * @return nullptr
     * @deprecated ICU 4.8 Use the MessagePattern class to analyze a ChoiceFormat pattern.
     */
    virtual const double* getLimits(int32_t& count) const;

    /**
     * Returns nullptr and 0.
     * Before ICU 4.8, this used to return the limit booleans array.
     *
     * @param count Will be set to 0.
     * @return nullptr
     * @deprecated ICU 4.8 Use the MessagePattern class to analyze a ChoiceFormat pattern.
     */
    virtual const UBool* getClosures(int32_t& count) const;

    /**
     * Returns nullptr and 0.
     * Before ICU 4.8, this used to return the array of choice strings.
     *
     * @param count Will be set to 0.
     * @return nullptr
     * @deprecated ICU 4.8 Use the MessagePattern class to analyze a ChoiceFormat pattern.
     */
    virtual const UnicodeString* getFormats(int32_t& count) const;


    using NumberFormat::format;

    /**
     * Formats a double number using this object's choices.
     *
     * @param number    The value to be formatted.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @return          Reference to 'appendTo' parameter.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual UnicodeString& format(double number,
                                  UnicodeString& appendTo,
                                  FieldPosition& pos) const override;
    /**
     * Formats an int32_t number using this object's choices.
     *
     * @param number    The value to be formatted.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @return          Reference to 'appendTo' parameter.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual UnicodeString& format(int32_t number,
                                  UnicodeString& appendTo,
                                  FieldPosition& pos) const override;

    /**
     * Formats an int64_t number using this object's choices.
     *
     * @param number    The value to be formatted.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @return          Reference to 'appendTo' parameter.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual UnicodeString& format(int64_t number,
                                  UnicodeString& appendTo,
                                  FieldPosition& pos) const override;

    /**
     * Formats an array of objects using this object's choices.
     *
     * @param objs      The array of objects to be formatted.
     * @param cnt       The size of objs.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @param success   Output param set to success/failure code on
     *                  exit.
     * @return          Reference to 'appendTo' parameter.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual UnicodeString& format(const Formattable* objs,
                                  int32_t cnt,
                                  UnicodeString& appendTo,
                                  FieldPosition& pos,
                                  UErrorCode& success) const;

   using NumberFormat::parse;

   /**
    * Looks for the longest match of any message string on the input text and,
    * if there is a match, sets the result object to the corresponding range's number.
    *
    * If no string matches, then the parsePosition is unchanged.
    *
    * @param text           The text to be parsed.
    * @param result         Formattable to be set to the parse result.
    *                       If parse fails, return contents are undefined.
    * @param parsePosition  The position to start parsing at on input.
    *                       On output, moved to after the last successfully
    *                       parse character. On parse failure, does not change.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
    */
    virtual void parse(const UnicodeString& text,
                       Formattable& result,
                       ParsePosition& parsePosition) const override;

    /**
     * Returns a unique class ID POLYMORPHICALLY. Part of ICU's "poor man's RTTI".
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * Returns the class ID for this class.  This is useful only for
     * comparing to a return value from getDynamicClassID().  For example:
     * <pre>
     * .       Base* polymorphic_pointer = createPolymorphicObject();
     * .       if (polymorphic_pointer->getDynamicClassID() ==
     * .           Derived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @deprecated ICU 49 Use MessageFormat instead, with plural and select arguments.
     */
    static UClassID U_EXPORT2 getStaticClassID();

private:
    /**
     * Converts a double value to a string.
     * @param value the double number to be converted.
     * @param string the result string.
     * @return the converted string.
     */
    static UnicodeString& dtos(double value, UnicodeString& string);

    ChoiceFormat() = delete; // default constructor not implemented

    /**
     * Construct a new ChoiceFormat with the limits and the corresponding formats
     * based on the pattern.
     *
     * @param newPattern   Pattern used to construct object.
     * @param parseError   Struct to receive information on position
     *                     of error if an error is encountered.
     * @param status       Output param to receive success code.  If the
     *                     pattern cannot be parsed, set to failure code.
     */
    ChoiceFormat(const UnicodeString& newPattern,
                 UParseError& parseError,
                 UErrorCode& status);

    friend class MessageFormat;

    virtual void setChoices(const double* limits,
                            const UBool* closures,
                            const UnicodeString* formats,
                            int32_t count,
                            UErrorCode &errorCode);

    /**
     * Finds the ChoiceFormat sub-message for the given number.
     * @param pattern A MessagePattern.
     * @param partIndex the index of the first ChoiceFormat argument style part.
     * @param number a number to be mapped to one of the ChoiceFormat argument's intervals
     * @return the sub-message start part index.
     */
    static int32_t findSubMessage(const MessagePattern &pattern, int32_t partIndex, double number);

    static double parseArgument(
            const MessagePattern &pattern, int32_t partIndex,
            const UnicodeString &source, ParsePosition &pos);

    /**
     * Matches the pattern string from the end of the partIndex to
     * the beginning of the limitPartIndex,
     * including all syntax except SKIP_SYNTAX,
     * against the source string starting at sourceOffset.
     * If they match, returns the length of the source string match.
     * Otherwise returns -1.
     */
    static int32_t matchStringUntilLimitPart(
            const MessagePattern &pattern, int32_t partIndex, int32_t limitPartIndex,
            const UnicodeString &source, int32_t sourceOffset);

    /**
     * Some of the ChoiceFormat constructors do not have a UErrorCode parameter.
     * We need _some_ way to provide one for the MessagePattern constructor.
     * Alternatively, the MessagePattern could be a pointer field, but that is
     * not nice either.
     */
    UErrorCode constructorErrorCode;

    /**
     * The MessagePattern which contains the parsed structure of the pattern string.
     *
     * Starting with ICU 4.8, the MessagePattern contains a sequence of
     * numeric/selector/message parts corresponding to the parsed pattern.
     * For details see the MessagePattern class API docs.
     */
    MessagePattern msgPattern;

    /**
     * Docs & fields from before ICU 4.8, before MessagePattern was used.
     * Commented out, and left only for explanation of semantics.
     * --------
     * Each ChoiceFormat divides the range -Inf..+Inf into fCount
     * intervals.  The intervals are:
     *
     *         0: fChoiceLimits[0]..fChoiceLimits[1]
     *         1: fChoiceLimits[1]..fChoiceLimits[2]
     *        ...
     *  fCount-2: fChoiceLimits[fCount-2]..fChoiceLimits[fCount-1]
     *  fCount-1: fChoiceLimits[fCount-1]..+Inf
     *
     * Interval 0 is special; during formatting (mapping numbers to
     * strings), it also contains all numbers less than
     * fChoiceLimits[0], as well as NaN values.
     *
     * Interval i maps to and from string fChoiceFormats[i].  When
     * parsing (mapping strings to numbers), then intervals map to
     * their lower limit, that is, interval i maps to fChoiceLimit[i].
     *
     * The intervals may be closed, half open, or open.  This affects
     * formatting but does not affect parsing.  Interval i is affected
     * by fClosures[i] and fClosures[i+1].  If fClosures[i]
     * is false, then the value fChoiceLimits[i] is in interval i.
     * That is, intervals i and i are:
     *
     *  i-1:                 ... x < fChoiceLimits[i]
     *    i: fChoiceLimits[i] <= x ...
     *
     * If fClosures[i] is true, then the value fChoiceLimits[i] is
     * in interval i-1.  That is, intervals i-1 and i are:
     *
     *  i-1:                ... x <= fChoiceLimits[i]
     *    i: fChoiceLimits[i] < x ...
     *
     * Because of the nature of interval 0, fClosures[0] has no
     * effect.
     */
    // double*         fChoiceLimits;
    // UBool*          fClosures;
    // UnicodeString*  fChoiceFormats;
    // int32_t         fCount;
};


U_NAMESPACE_END

#endif  // U_HIDE_DEPRECATED_API
#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // CHOICFMT_H
//eof
