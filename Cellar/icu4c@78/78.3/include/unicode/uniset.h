// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
***************************************************************************
* Copyright (C) 1999-2016, International Business Machines Corporation
* and others. All Rights Reserved.
***************************************************************************
*   Date        Name        Description
*   10/20/99    alan        Creation.
***************************************************************************
*/

#ifndef UNICODESET_H
#define UNICODESET_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/ucpmap.h"
#include "unicode/unifilt.h"
#include "unicode/unistr.h"
#include "unicode/uset.h"

/**
 * \file
 * \brief C++ API: Unicode Set
 */

U_NAMESPACE_BEGIN

// Forward Declarations.
class BMPSet;
class ParsePosition;
class RBBIRuleScanner;
class SymbolTable;
class UnicodeSetStringSpan;
class UVector;
class RuleCharacterIterator;

/**
 * A mutable set of Unicode characters and multicharacter strings.  Objects of this class
 * represent <em>character classes</em> used in regular expressions.
 * A character specifies a subset of Unicode code points.  Legal
 * code points are U+0000 to U+10FFFF, inclusive.
 *
 * <p>The UnicodeSet class is not designed to be subclassed.
 *
 * <p><code>UnicodeSet</code> supports two APIs. The first is the
 * <em>operand</em> API that allows the caller to modify the value of
 * a <code>UnicodeSet</code> object. It conforms to Java 2's
 * <code>java.util.Set</code> interface, although
 * <code>UnicodeSet</code> does not actually implement that
 * interface. All methods of <code>Set</code> are supported, with the
 * modification that they take a character range or single character
 * instead of an <code>Object</code>, and they take a
 * <code>UnicodeSet</code> instead of a <code>Collection</code>.  The
 * operand API may be thought of in terms of boolean logic: a boolean
 * OR is implemented by <code>add</code>, a boolean AND is implemented
 * by <code>retain</code>, a boolean XOR is implemented by
 * <code>complement</code> taking an argument, and a boolean NOT is
 * implemented by <code>complement</code> with no argument.  In terms
 * of traditional set theory function names, <code>add</code> is a
 * union, <code>retain</code> is an intersection, <code>remove</code>
 * is an asymmetric difference, and <code>complement</code> with no
 * argument is a set complement with respect to the superset range
 * <code>MIN_VALUE-MAX_VALUE</code>
 *
 * <p>The second API is the
 * <code>applyPattern()</code>/<code>toPattern()</code> API from the
 * <code>java.text.Format</code>-derived classes.  Unlike the
 * methods that add characters, add categories, and control the logic
 * of the set, the method <code>applyPattern()</code> sets all
 * attributes of a <code>UnicodeSet</code> at once, based on a
 * string pattern.
 *
 * <p><b>Pattern syntax</b></p>
 *
 * Patterns are accepted by the constructors and the
 * <code>applyPattern()</code> methods and returned by the
 * <code>toPattern()</code> method.  These patterns follow a syntax
 * similar to that employed by version 8 regular expression character
 * classes.  Here are some simple examples:
 *
 * \htmlonly<blockquote>\endhtmlonly
 *   <table>
 *     <tr align="top">
 *       <td nowrap valign="top" align="left"><code>[]</code></td>
 *       <td valign="top">No characters</td>
 *     </tr><tr align="top">
 *       <td nowrap valign="top" align="left"><code>[a]</code></td>
 *       <td valign="top">The character 'a'</td>
 *     </tr><tr align="top">
 *       <td nowrap valign="top" align="left"><code>[ae]</code></td>
 *       <td valign="top">The characters 'a' and 'e'</td>
 *     </tr>
 *     <tr>
 *       <td nowrap valign="top" align="left"><code>[a-e]</code></td>
 *       <td valign="top">The characters 'a' through 'e' inclusive, in Unicode code
 *       point order</td>
 *     </tr>
 *     <tr>
 *       <td nowrap valign="top" align="left"><code>[\\u4E01]</code></td>
 *       <td valign="top">The character U+4E01</td>
 *     </tr>
 *     <tr>
 *       <td nowrap valign="top" align="left"><code>[a{ab}{ac}]</code></td>
 *       <td valign="top">The character 'a' and the multicharacter strings &quot;ab&quot; and
 *       &quot;ac&quot;</td>
 *     </tr>
 *     <tr>
 *       <td nowrap valign="top" align="left"><code>[\\p{Lu}]</code></td>
 *       <td valign="top">All characters in the general category Uppercase Letter</td>
 *     </tr>
 *   </table>
 * \htmlonly</blockquote>\endhtmlonly
 *
 * Any character may be preceded by a backslash in order to remove any special
 * meaning.  White space characters, as defined by UCharacter.isWhitespace(), are
 * ignored, unless they are escaped.
 *
 * <p>Property patterns specify a set of characters having a certain
 * property as defined by the Unicode standard.  Both the POSIX-like
 * "[:Lu:]" and the Perl-like syntax "\\p{Lu}" are recognized.  For a
 * complete list of supported property patterns, see the User's Guide
 * for UnicodeSet at
 * <a href="https://unicode-org.github.io/icu/userguide/strings/unicodeset">
 * https://unicode-org.github.io/icu/userguide/strings/unicodeset</a>.
 * Actual determination of property data is defined by the underlying
 * Unicode database as implemented by UCharacter.
 *
 * <p>Patterns specify individual characters, ranges of characters, and
 * Unicode property sets.  When elements are concatenated, they
 * specify their union.  To complement a set, place a '^' immediately
 * after the opening '['.  Property patterns are inverted by modifying
 * their delimiters; "[:^foo]" and "\\P{foo}".  In any other location,
 * '^' has no special meaning.
 *
 * <p>Since ICU 70, "[^...]", "[:^foo]", "\\P{foo}", and "[:binaryProperty=No:]"
 * perform a “code point complement” (all code points minus the original set),
 * removing all multicharacter strings,
 * equivalent to <code>.complement().removeAllStrings()</code>.
 * The complement() API function continues to perform a
 * symmetric difference with all code points and thus retains all multicharacter strings.
 *
 * <p>Ranges are indicated by placing two a '-' between two
 * characters, as in "a-z".  This specifies the range of all
 * characters from the left to the right, in Unicode order.  If the
 * left character is greater than or equal to the
 * right character it is a syntax error.  If a '-' occurs as the first
 * character after the opening '[' or '[^', or if it occurs as the
 * last character before the closing ']', then it is taken as a
 * literal.  Thus "[a\-b]", "[-ab]", and "[ab-]" all indicate the same
 * set of three characters, 'a', 'b', and '-'.
 *
 * <p>Sets may be intersected using the '&' operator or the asymmetric
 * set difference may be taken using the '-' operator, for example,
 * "[[:L:]&[\\u0000-\\u0FFF]]" indicates the set of all Unicode letters
 * with values less than 4096.  Operators ('&' and '|') have equal
 * precedence and bind left-to-right.  Thus
 * "[[:L:]-[a-z]-[\\u0100-\\u01FF]]" is equivalent to
 * "[[[:L:]-[a-z]]-[\\u0100-\\u01FF]]".  This only really matters for
 * difference; intersection is commutative.
 *
 * <table>
 * <tr valign=top><td nowrap><code>[a]</code><td>The set containing 'a'
 * <tr valign=top><td nowrap><code>[a-z]</code><td>The set containing 'a'
 * through 'z' and all letters in between, in Unicode order
 * <tr valign=top><td nowrap><code>[^a-z]</code><td>The set containing
 * all characters but 'a' through 'z',
 * that is, U+0000 through 'a'-1 and 'z'+1 through U+10FFFF
 * <tr valign=top><td nowrap><code>[[<em>pat1</em>][<em>pat2</em>]]</code>
 * <td>The union of sets specified by <em>pat1</em> and <em>pat2</em>
 * <tr valign=top><td nowrap><code>[[<em>pat1</em>]&[<em>pat2</em>]]</code>
 * <td>The intersection of sets specified by <em>pat1</em> and <em>pat2</em>
 * <tr valign=top><td nowrap><code>[[<em>pat1</em>]-[<em>pat2</em>]]</code>
 * <td>The asymmetric difference of sets specified by <em>pat1</em> and
 * <em>pat2</em>
 * <tr valign=top><td nowrap><code>[:Lu:] or \\p{Lu}</code>
 * <td>The set of characters having the specified
 * Unicode property; in
 * this case, Unicode uppercase letters
 * <tr valign=top><td nowrap><code>[:^Lu:] or \\P{Lu}</code>
 * <td>The set of characters <em>not</em> having the given
 * Unicode property
 * </table>
 *
 * <p><b>Formal syntax</b></p>
 *
 * \htmlonly<blockquote>\endhtmlonly
 *   <table>
 *     <tr align="top">
 *       <td nowrap valign="top" align="right"><code>pattern :=&nbsp; </code></td>
 *       <td valign="top"><code>('[' '^'? item* ']') |
 *       property</code></td>
 *     </tr>
 *     <tr align="top">
 *       <td nowrap valign="top" align="right"><code>item :=&nbsp; </code></td>
 *       <td valign="top"><code>char | (char '-' char) | pattern-expr<br>
 *       </code></td>
 *     </tr>
 *     <tr align="top">
 *       <td nowrap valign="top" align="right"><code>pattern-expr :=&nbsp; </code></td>
 *       <td valign="top"><code>pattern | pattern-expr pattern |
 *       pattern-expr op pattern<br>
 *       </code></td>
 *     </tr>
 *     <tr align="top">
 *       <td nowrap valign="top" align="right"><code>op :=&nbsp; </code></td>
 *       <td valign="top"><code>'&amp;' | '-'<br>
 *       </code></td>
 *     </tr>
 *     <tr align="top">
 *       <td nowrap valign="top" align="right"><code>special :=&nbsp; </code></td>
 *       <td valign="top"><code>'[' | ']' | '-'<br>
 *       </code></td>
 *     </tr>
 *     <tr align="top">
 *       <td nowrap valign="top" align="right"><code>char :=&nbsp; </code></td>
 *       <td valign="top"><em>any character that is not</em><code> special<br>
 *       | ('\' </code><em>any character</em><code>)<br>
 *       | ('\\u' hex hex hex hex)<br>
 *       </code></td>
 *     </tr>
 *     <tr align="top">
 *       <td nowrap valign="top" align="right"><code>hex :=&nbsp; </code></td>
 *       <td valign="top"><code>'0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' |<br>
 *       &nbsp;&nbsp;&nbsp;&nbsp;'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'a' | 'b' | 'c' | 'd' | 'e' | 'f'</code></td>
 *     </tr>
 *     <tr>
 *       <td nowrap valign="top" align="right"><code>property :=&nbsp; </code></td>
 *       <td valign="top"><em>a Unicode property set pattern</em></td>
 *     </tr>
 *   </table>
 *   <br>
 *   <table border="1">
 *     <tr>
 *       <td>Legend: <table>
 *         <tr>
 *           <td nowrap valign="top"><code>a := b</code></td>
 *           <td width="20" valign="top">&nbsp; </td>
 *           <td valign="top"><code>a</code> may be replaced by <code>b</code> </td>
 *         </tr>
 *         <tr>
 *           <td nowrap valign="top"><code>a?</code></td>
 *           <td valign="top"></td>
 *           <td valign="top">zero or one instance of <code>a</code><br>
 *           </td>
 *         </tr>
 *         <tr>
 *           <td nowrap valign="top"><code>a*</code></td>
 *           <td valign="top"></td>
 *           <td valign="top">one or more instances of <code>a</code><br>
 *           </td>
 *         </tr>
 *         <tr>
 *           <td nowrap valign="top"><code>a | b</code></td>
 *           <td valign="top"></td>
 *           <td valign="top">either <code>a</code> or <code>b</code><br>
 *           </td>
 *         </tr>
 *         <tr>
 *           <td nowrap valign="top"><code>'a'</code></td>
 *           <td valign="top"></td>
 *           <td valign="top">the literal string between the quotes </td>
 *         </tr>
 *       </table>
 *       </td>
 *     </tr>
 *   </table>
 * \htmlonly</blockquote>\endhtmlonly
 * 
 * <p>Note:
 *  - Most UnicodeSet methods do not take a UErrorCode parameter because
 *   there are usually very few opportunities for failure other than a shortage
 *   of memory, error codes in low-level C++ string methods would be inconvenient,
 *   and the error code as the last parameter (ICU convention) would prevent
 *   the use of default parameter values.
 *   Instead, such methods set the UnicodeSet into a "bogus" state
 *   (see isBogus()) if an error occurs.
 *
 * @author Alan Liu
 * @stable ICU 2.0
 */
class U_COMMON_API UnicodeSet final : public UnicodeFilter {
private:
    /**
     * Enough for sets with few ranges.
     * For example, White_Space has 10 ranges, list length 21.
     */
    static constexpr int32_t INITIAL_CAPACITY = 25;
    // fFlags constant
    static constexpr uint8_t kIsBogus = 1;  // This set is bogus (i.e. not valid)

    UChar32* list = stackList; // MUST be terminated with HIGH
    int32_t capacity = INITIAL_CAPACITY; // capacity of list
    int32_t len = 1; // length of list used; 1 <= len <= capacity
    uint8_t fFlags = 0;         // Bit flag (see constants above)

    BMPSet *bmpSet = nullptr; // The set is frozen iff either bmpSet or stringSpan is not nullptr.
    UChar32* buffer = nullptr; // internal buffer, may be nullptr
    int32_t bufferCapacity = 0; // capacity of buffer

    /**
     * The pattern representation of this set.  This may not be the
     * most economical pattern.  It is the pattern supplied to
     * applyPattern(), with variables substituted and whitespace
     * removed.  For sets constructed without applyPattern(), or
     * modified using the non-pattern API, this string will be empty,
     * indicating that toPattern() must generate a pattern
     * representation from the inversion list.
     */
    char16_t *pat = nullptr;
    int32_t patLen = 0;

    UVector* strings_ = nullptr; // maintained in sorted order
    UnicodeSetStringSpan *stringSpan = nullptr;

    /**
     * Initial list array.
     * Avoids some heap allocations, and list is never nullptr.
     * Increases the object size a bit.
     */
    UChar32 stackList[INITIAL_CAPACITY];

public:
    /**
     * Determine if this object contains a valid set.
     * A bogus set has no value. It is different from an empty set.
     * It can be used to indicate that no set value is available.
     *
     * @return true if the set is bogus/invalid, false otherwise
     * @see setToBogus()
     * @stable ICU 4.0
     */
    inline UBool isBogus() const;

    /**
     * Make this UnicodeSet object invalid.
     * The string will test true with isBogus().
     *
     * A bogus set has no value. It is different from an empty set.
     * It can be used to indicate that no set value is available.
     *
     * This utility function is used throughout the UnicodeSet
     * implementation to indicate that a UnicodeSet operation failed,
     * and may be used in other functions,
     * especially but not exclusively when such functions do not
     * take a UErrorCode for simplicity.
     *
     * @see isBogus()
     * @stable ICU 4.0
     */
    void setToBogus();

public:

    enum {
        /**
         * Minimum value that can be stored in a UnicodeSet.
         * @stable ICU 2.4
         */
        MIN_VALUE = 0,

        /**
         * Maximum value that can be stored in a UnicodeSet.
         * @stable ICU 2.4
         */
        MAX_VALUE = 0x10ffff
    };

    //----------------------------------------------------------------
    // Constructors &c
    //----------------------------------------------------------------

public:

    /**
     * Constructs an empty set.
     * @stable ICU 2.0
     */
    UnicodeSet();

    /**
     * Constructs a set containing the given range. If <code>end <
     * start</code> then an empty set is created.
     *
     * @param start first character, inclusive, of range
     * @param end last character, inclusive, of range
     * @stable ICU 2.4
     */
    UnicodeSet(UChar32 start, UChar32 end);

#ifndef U_HIDE_INTERNAL_API
    /**
     * @internal
     */
    enum ESerialization {
      kSerialized  /* result of serialize() */
    };

    /**
     * Constructs a set from the output of serialize().
     *
     * @param buffer the 16 bit array
     * @param bufferLen the original length returned from serialize()
     * @param serialization the value 'kSerialized'
     * @param status error code
     *
     * @internal
     */
    UnicodeSet(const uint16_t buffer[], int32_t bufferLen,
               ESerialization serialization, UErrorCode &status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Constructs a set from the given pattern.  See the class
     * description for the syntax of the pattern language.
     * @param pattern a string specifying what characters are in the set
     * @param status returns <code>U_ILLEGAL_ARGUMENT_ERROR</code> if the pattern
     * contains a syntax error.
     * @stable ICU 2.0
     */
    UnicodeSet(const UnicodeString& pattern,
               UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Constructs a set from the given pattern.  See the class
     * description for the syntax of the pattern language.
     * @param pattern a string specifying what characters are in the set
     * @param options bitmask for options to apply to the pattern.
     * Valid options are USET_IGNORE_SPACE and
     * at most one of USET_CASE_INSENSITIVE, USET_ADD_CASE_MAPPINGS, USET_SIMPLE_CASE_INSENSITIVE.
     * These case options are mutually exclusive.
     * @param symbols a symbol table mapping variable names to values
     * and stand-in characters to UnicodeSets; may be nullptr
     * @param status returns <code>U_ILLEGAL_ARGUMENT_ERROR</code> if the pattern
     * contains a syntax error.
     * @internal
     */
    UnicodeSet(const UnicodeString& pattern,
               uint32_t options,
               const SymbolTable* symbols,
               UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Constructs a set from the given pattern.  See the class description
     * for the syntax of the pattern language.
     * @param pattern a string specifying what characters are in the set
     * @param pos on input, the position in pattern at which to start parsing.
     * On output, the position after the last character parsed.
     * @param options bitmask for options to apply to the pattern.
     * Valid options are USET_IGNORE_SPACE and
     * at most one of USET_CASE_INSENSITIVE, USET_ADD_CASE_MAPPINGS, USET_SIMPLE_CASE_INSENSITIVE.
     * These case options are mutually exclusive.
     * @param symbols a symbol table mapping variable names to values
     * and stand-in characters to UnicodeSets; may be nullptr
     * @param status input-output error code
     * @stable ICU 2.8
     */
    UnicodeSet(const UnicodeString& pattern, ParsePosition& pos,
               uint32_t options,
               const SymbolTable* symbols,
               UErrorCode& status);

    /**
     * Constructs a set that is identical to the given UnicodeSet.
     * @stable ICU 2.0
     */
    UnicodeSet(const UnicodeSet& o);

    /**
     * Destructs the set.
     * @stable ICU 2.0
     */
    virtual ~UnicodeSet();

    /**
     * Assigns this object to be a copy of another.
     * A frozen set will not be modified.
     * @stable ICU 2.0
     */
    UnicodeSet& operator=(const UnicodeSet& o);

    /**
     * Compares the specified object with this set for equality.  Returns
     * <tt>true</tt> if the two sets
     * have the same size, and every member of the specified set is
     * contained in this set (or equivalently, every member of this set is
     * contained in the specified set).
     *
     * @param o set to be compared for equality with this set.
     * @return <tt>true</tt> if the specified set is equal to this set.
     * @stable ICU 2.0
     */
    bool operator==(const UnicodeSet& o) const;

    /**
     * Compares the specified object with this set for equality.  Returns
     * <tt>true</tt> if the specified set is not equal to this set.
     * @stable ICU 2.0
     */
    inline bool operator!=(const UnicodeSet& o) const;

    /**
     * Returns a copy of this object.  All UnicodeFunctor objects have
     * to support cloning in order to allow classes using
     * UnicodeFunctors, such as Transliterator, to implement cloning.
     * If this set is frozen, then the clone will be frozen as well.
     * Use cloneAsThawed() for a mutable clone of a frozen set.
     * @see cloneAsThawed
     * @stable ICU 2.0
     */
    virtual UnicodeSet* clone() const override;

    /**
     * Returns the hash code value for this set.
     *
     * @return the hash code value for this set.
     * @see Object#hashCode()
     * @stable ICU 2.0
     */
    int32_t hashCode() const;

    /**
     * Get a UnicodeSet pointer from a USet
     *
     * @param uset a USet (the ICU plain C type for UnicodeSet)
     * @return the corresponding UnicodeSet pointer.
     *
     * @stable ICU 4.2
     */
    inline static UnicodeSet *fromUSet(USet *uset);

    /**
     * Get a UnicodeSet pointer from a const USet
     *
     * @param uset a const USet (the ICU plain C type for UnicodeSet)
     * @return the corresponding UnicodeSet pointer.
     *
     * @stable ICU 4.2
     */
    inline static const UnicodeSet *fromUSet(const USet *uset);
    
    /**
     * Produce a USet * pointer for this UnicodeSet.
     * USet is the plain C type for UnicodeSet
     *
     * @return a USet pointer for this UnicodeSet
     * @stable ICU 4.2
     */
    inline USet *toUSet();


    /**
     * Produce a const USet * pointer for this UnicodeSet.
     * USet is the plain C type for UnicodeSet
     *
     * @return a const USet pointer for this UnicodeSet
     * @stable ICU 4.2
     */
    inline const USet * toUSet() const;


    //----------------------------------------------------------------
    // Freezable API
    //----------------------------------------------------------------

    /**
     * Determines whether the set has been frozen (made immutable) or not.
     * See the ICU4J Freezable interface for details.
     * @return true/false for whether the set has been frozen
     * @see freeze
     * @see cloneAsThawed
     * @stable ICU 3.8
     */
    inline UBool isFrozen() const;

    /**
     * Freeze the set (make it immutable).
     * Once frozen, it cannot be unfrozen and is therefore thread-safe
     * until it is deleted.
     * See the ICU4J Freezable interface for details.
     * Freezing the set may also make some operations faster, for example
     * contains() and span().
     * A frozen set will not be modified. (It remains frozen.)
     * @return this set.
     * @see isFrozen
     * @see cloneAsThawed
     * @stable ICU 3.8
     */
    UnicodeSet *freeze();

    /**
     * Clone the set and make the clone mutable.
     * See the ICU4J Freezable interface for details.
     * @return the mutable clone
     * @see freeze
     * @see isFrozen
     * @stable ICU 3.8
     */
    UnicodeSet *cloneAsThawed() const;

    //----------------------------------------------------------------
    // Public API
    //----------------------------------------------------------------

    /**
     * Make this object represent the range `start - end`.
     * If `start > end` then this object is set to an empty range.
     * A frozen set will not be modified.
     *
     * @param start first character in the set, inclusive
     * @param end last character in the set, inclusive
     * @stable ICU 2.4
     */
    UnicodeSet& set(UChar32 start, UChar32 end);

    /**
     * Return true if the given position, in the given pattern, appears
     * to be the start of a UnicodeSet pattern.
     * @stable ICU 2.4
     */
    static UBool resemblesPattern(const UnicodeString& pattern,
                                  int32_t pos);

    /**
     * Modifies this set to represent the set specified by the given
     * pattern, ignoring Unicode Pattern_White_Space characters.
     * See the class description for the syntax of the pattern language.
     * A frozen set will not be modified.
     * @param pattern a string specifying what characters are in the set
     * @param status returns <code>U_ILLEGAL_ARGUMENT_ERROR</code> if the pattern
     * contains a syntax error.
     * <em> Empties the set passed before applying the pattern.</em>
     * @return a reference to this
     * @stable ICU 2.0
     */
    UnicodeSet& applyPattern(const UnicodeString& pattern,
                             UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Modifies this set to represent the set specified by the given
     * pattern, optionally ignoring Unicode Pattern_White_Space characters.
     * See the class description for the syntax of the pattern language.
     * A frozen set will not be modified.
     * @param pattern a string specifying what characters are in the set
     * @param options bitmask for options to apply to the pattern.
     * Valid options are USET_IGNORE_SPACE and
     * at most one of USET_CASE_INSENSITIVE, USET_ADD_CASE_MAPPINGS, USET_SIMPLE_CASE_INSENSITIVE.
     * These case options are mutually exclusive.
     * @param symbols a symbol table mapping variable names to
     * values and stand-ins to UnicodeSets; may be nullptr
     * @param status returns <code>U_ILLEGAL_ARGUMENT_ERROR</code> if the pattern
     * contains a syntax error.
     *<em> Empties the set passed before applying the pattern.</em>
     * @return a reference to this
     * @internal
     */
    UnicodeSet& applyPattern(const UnicodeString& pattern,
                             uint32_t options,
                             const SymbolTable* symbols,
                             UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Parses the given pattern, starting at the given position.  The
     * character at pattern.charAt(pos.getIndex()) must be '[', or the
     * parse fails.  Parsing continues until the corresponding closing
     * ']'.  If a syntax error is encountered between the opening and
     * closing brace, the parse fails.  Upon return from a successful
     * parse, the ParsePosition is updated to point to the character
     * following the closing ']', and a StringBuffer containing a
     * pairs list for the parsed pattern is returned.  This method calls
     * itself recursively to parse embedded subpatterns.
     *<em> Empties the set passed before applying the pattern.</em>
     * A frozen set will not be modified.
     *
     * @param pattern the string containing the pattern to be parsed.
     * The portion of the string from pos.getIndex(), which must be a
     * '[', to the corresponding closing ']', is parsed.
     * @param pos upon entry, the position at which to being parsing.
     * The character at pattern.charAt(pos.getIndex()) must be a '['.
     * Upon return from a successful parse, pos.getIndex() is either
     * the character after the closing ']' of the parsed pattern, or
     * pattern.length() if the closing ']' is the last character of
     * the pattern string.
     * @param options bitmask for options to apply to the pattern.
     * Valid options are USET_IGNORE_SPACE and
     * at most one of USET_CASE_INSENSITIVE, USET_ADD_CASE_MAPPINGS, USET_SIMPLE_CASE_INSENSITIVE.
     * These case options are mutually exclusive.
     * @param symbols a symbol table mapping variable names to
     * values and stand-ins to UnicodeSets; may be nullptr
     * @param status returns <code>U_ILLEGAL_ARGUMENT_ERROR</code> if the pattern
     * contains a syntax error.
     * @return a reference to this
     * @stable ICU 2.8
     */
    UnicodeSet& applyPattern(const UnicodeString& pattern,
                             ParsePosition& pos,
                             uint32_t options,
                             const SymbolTable* symbols,
                             UErrorCode& status);

    /**
     * Returns a string representation of this set.  If the result of
     * calling this function is passed to a UnicodeSet constructor, it
     * will produce another set that is equal to this one.
     * A frozen set will not be modified.
     * @param result the string to receive the rules.  Previous
     * contents will be deleted.
     * @param escapeUnprintable if true then convert unprintable
     * character to their hex escape representations, \\uxxxx or
     * \\Uxxxxxxxx.  Unprintable characters are those other than
     * U+000A, U+0020..U+007E.
     * @stable ICU 2.0
     */
    virtual UnicodeString& toPattern(UnicodeString& result,
                                     UBool escapeUnprintable = false) const override;

    /**
     * Modifies this set to contain those code points which have the given value
     * for the given binary or enumerated property, as returned by
     * u_getIntPropertyValue.  Prior contents of this set are lost.
     * A frozen set will not be modified.
     *
     * @param prop a property in the range UCHAR_BIN_START..UCHAR_BIN_LIMIT-1
     * or UCHAR_INT_START..UCHAR_INT_LIMIT-1
     * or UCHAR_MASK_START..UCHAR_MASK_LIMIT-1.
     *
     * @param value a value in the range u_getIntPropertyMinValue(prop)..
     * u_getIntPropertyMaxValue(prop), with one exception.  If prop is
     * UCHAR_GENERAL_CATEGORY_MASK, then value should not be a UCharCategory, but
     * rather a mask value produced by U_GET_GC_MASK().  This allows grouped
     * categories such as [:L:] to be represented.
     *
     * @param ec error code input/output parameter
     *
     * @return a reference to this set
     *
     * @stable ICU 2.4
     */
    UnicodeSet& applyIntPropertyValue(UProperty prop,
                                      int32_t value,
                                      UErrorCode& ec);

    /**
     * Modifies this set to contain those code points which have the
     * given value for the given property.  Prior contents of this
     * set are lost.
     * A frozen set will not be modified.
     *
     * @param prop a property alias, either short or long.  The name is matched
     * loosely.  See PropertyAliases.txt for names and a description of loose
     * matching.  If the value string is empty, then this string is interpreted
     * as either a General_Category value alias, a Script value alias, a binary
     * property alias, or a special ID.  Special IDs are matched loosely and
     * correspond to the following sets:
     *
     * "ANY" = [\\u0000-\\U0010FFFF],
     * "ASCII" = [\\u0000-\\u007F],
     * "Assigned" = [:^Cn:].
     *
     * @param value a value alias, either short or long.  The name is matched
     * loosely.  See PropertyValueAliases.txt for names and a description of
     * loose matching.  In addition to aliases listed, numeric values and
     * canonical combining classes may be expressed numerically, e.g., ("nv",
     * "0.5") or ("ccc", "220").  The value string may also be empty.
     *
     * @param ec error code input/output parameter
     *
     * @return a reference to this set
     *
     * @stable ICU 2.4
     */
    UnicodeSet& applyPropertyAlias(const UnicodeString& prop,
                                   const UnicodeString& value,
                                   UErrorCode& ec);

    /**
     * Returns the number of elements in this set (its cardinality).
     * Note than the elements of a set may include both individual
     * codepoints and strings.
     *
     * This is slower than getRangeCount() because
     * it counts the code points of all ranges.
     *
     * @return the number of elements in this set (its cardinality).
     * @stable ICU 2.0
     * @see getRangeCount
     */
    int32_t size() const;

    /**
     * Returns <tt>true</tt> if this set contains no elements.
     *
     * @return <tt>true</tt> if this set contains no elements.
     * @stable ICU 2.0
     */
    UBool isEmpty() const;

    /**
     * @return true if this set contains multi-character strings or the empty string.
     * @stable ICU 70
     */
    UBool hasStrings() const;

    /**
     * Returns true if this set contains the given character.
     * This function works faster with a frozen set.
     * @param c character to be checked for containment
     * @return true if the test condition is met
     * @stable ICU 2.0
     */
    virtual UBool contains(UChar32 c) const override;

    /**
     * Returns true if this set contains every character
     * of the given range.
     * @param start first character, inclusive, of the range
     * @param end last character, inclusive, of the range
     * @return true if the test condition is met
     * @stable ICU 2.0
     */
    UBool contains(UChar32 start, UChar32 end) const;

    /**
     * Returns <tt>true</tt> if this set contains the given
     * multicharacter string.
     * @param s string to be checked for containment
     * @return <tt>true</tt> if this set contains the specified string
     * @stable ICU 2.4
     */
    UBool contains(const UnicodeString& s) const;

    /**
     * Returns true if this set contains all the characters and strings
     * of the given set.
     * @param c set to be checked for containment
     * @return true if the test condition is met
     * @stable ICU 2.4
     */
    UBool containsAll(const UnicodeSet& c) const;

    /**
     * Returns true if this set contains all the characters
     * of the given string.
     * @param s string containing characters to be checked for containment
     * @return true if the test condition is met
     * @stable ICU 2.4
     */
    UBool containsAll(const UnicodeString& s) const;

    /**
     * Returns true if this set contains none of the characters
     * of the given range.
     * @param start first character, inclusive, of the range
     * @param end last character, inclusive, of the range
     * @return true if the test condition is met
     * @stable ICU 2.4
     */
    UBool containsNone(UChar32 start, UChar32 end) const;

    /**
     * Returns true if this set contains none of the characters and strings
     * of the given set.
     * @param c set to be checked for containment
     * @return true if the test condition is met
     * @stable ICU 2.4
     */
    UBool containsNone(const UnicodeSet& c) const;

    /**
     * Returns true if this set contains none of the characters
     * of the given string.
     * @param s string containing characters to be checked for containment
     * @return true if the test condition is met
     * @stable ICU 2.4
     */
    UBool containsNone(const UnicodeString& s) const;

    /**
     * Returns true if this set contains one or more of the characters
     * in the given range.
     * @param start first character, inclusive, of the range
     * @param end last character, inclusive, of the range
     * @return true if the condition is met
     * @stable ICU 2.4
     */
    inline UBool containsSome(UChar32 start, UChar32 end) const;

    /**
     * Returns true if this set contains one or more of the characters
     * and strings of the given set.
     * @param s The set to be checked for containment
     * @return true if the condition is met
     * @stable ICU 2.4
     */
    inline UBool containsSome(const UnicodeSet& s) const;

    /**
     * Returns true if this set contains one or more of the characters
     * of the given string.
     * @param s string containing characters to be checked for containment
     * @return true if the condition is met
     * @stable ICU 2.4
     */
    inline UBool containsSome(const UnicodeString& s) const;

    /**
     * Returns the length of the initial substring of the input string which
     * consists only of characters and strings that are contained in this set
     * (USET_SPAN_CONTAINED, USET_SPAN_SIMPLE),
     * or only of characters and strings that are not contained
     * in this set (USET_SPAN_NOT_CONTAINED).
     * See USetSpanCondition for details.
     * Similar to the strspn() C library function.
     * Unpaired surrogates are treated according to contains() of their surrogate code points.
     * This function works faster with a frozen set and with a non-negative string length argument.
     * @param s start of the string
     * @param length of the string; can be -1 for NUL-terminated
     * @param spanCondition specifies the containment condition
     * @return the length of the initial substring according to the spanCondition;
     *         0 if the start of the string does not fit the spanCondition
     * @stable ICU 3.8
     * @see USetSpanCondition
     */
    int32_t span(const char16_t *s, int32_t length, USetSpanCondition spanCondition) const;

    /**
     * Returns the end of the substring of the input string according to the USetSpanCondition.
     * Same as <code>start+span(s.getBuffer()+start, s.length()-start, spanCondition)</code>
     * after pinning start to 0<=start<=s.length().
     * @param s the string
     * @param start the start index in the string for the span operation
     * @param spanCondition specifies the containment condition
     * @return the exclusive end of the substring according to the spanCondition;
     *         the substring s.tempSubStringBetween(start, end) fulfills the spanCondition
     * @stable ICU 4.4
     * @see USetSpanCondition
     */
    inline int32_t span(const UnicodeString &s, int32_t start, USetSpanCondition spanCondition) const;

    /**
     * Returns the start of the trailing substring of the input string which
     * consists only of characters and strings that are contained in this set
     * (USET_SPAN_CONTAINED, USET_SPAN_SIMPLE),
     * or only of characters and strings that are not contained
     * in this set (USET_SPAN_NOT_CONTAINED).
     * See USetSpanCondition for details.
     * Unpaired surrogates are treated according to contains() of their surrogate code points.
     * This function works faster with a frozen set and with a non-negative string length argument.
     * @param s start of the string
     * @param length of the string; can be -1 for NUL-terminated
     * @param spanCondition specifies the containment condition
     * @return the start of the trailing substring according to the spanCondition;
     *         the string length if the end of the string does not fit the spanCondition
     * @stable ICU 3.8
     * @see USetSpanCondition
     */
    int32_t spanBack(const char16_t *s, int32_t length, USetSpanCondition spanCondition) const;

    /**
     * Returns the start of the substring of the input string according to the USetSpanCondition.
     * Same as <code>spanBack(s.getBuffer(), limit, spanCondition)</code>
     * after pinning limit to 0<=end<=s.length().
     * @param s the string
     * @param limit the exclusive-end index in the string for the span operation
     *              (use s.length() or INT32_MAX for spanning back from the end of the string)
     * @param spanCondition specifies the containment condition
     * @return the start of the substring according to the spanCondition;
     *         the substring s.tempSubStringBetween(start, limit) fulfills the spanCondition
     * @stable ICU 4.4
     * @see USetSpanCondition
     */
    inline int32_t spanBack(const UnicodeString &s, int32_t limit, USetSpanCondition spanCondition) const;

    /**
     * Returns the length of the initial substring of the input string which
     * consists only of characters and strings that are contained in this set
     * (USET_SPAN_CONTAINED, USET_SPAN_SIMPLE),
     * or only of characters and strings that are not contained
     * in this set (USET_SPAN_NOT_CONTAINED).
     * See USetSpanCondition for details.
     * Similar to the strspn() C library function.
     * Malformed byte sequences are treated according to contains(0xfffd).
     * This function works faster with a frozen set and with a non-negative string length argument.
     * @param s start of the string (UTF-8)
     * @param length of the string; can be -1 for NUL-terminated
     * @param spanCondition specifies the containment condition
     * @return the length of the initial substring according to the spanCondition;
     *         0 if the start of the string does not fit the spanCondition
     * @stable ICU 3.8
     * @see USetSpanCondition
     */
    int32_t spanUTF8(const char *s, int32_t length, USetSpanCondition spanCondition) const;

    /**
     * Returns the start of the trailing substring of the input string which
     * consists only of characters and strings that are contained in this set
     * (USET_SPAN_CONTAINED, USET_SPAN_SIMPLE),
     * or only of characters and strings that are not contained
     * in this set (USET_SPAN_NOT_CONTAINED).
     * See USetSpanCondition for details.
     * Malformed byte sequences are treated according to contains(0xfffd).
     * This function works faster with a frozen set and with a non-negative string length argument.
     * @param s start of the string (UTF-8)
     * @param length of the string; can be -1 for NUL-terminated
     * @param spanCondition specifies the containment condition
     * @return the start of the trailing substring according to the spanCondition;
     *         the string length if the end of the string does not fit the spanCondition
     * @stable ICU 3.8
     * @see USetSpanCondition
     */
    int32_t spanBackUTF8(const char *s, int32_t length, USetSpanCondition spanCondition) const;

    /**
     * Implement UnicodeMatcher::matches()
     * @stable ICU 2.4
     */
    UMatchDegree matches(const Replaceable& text,
                         int32_t& offset,
                         int32_t limit,
                         UBool incremental) override;

private:
    /**
     * Returns the longest match for s in text at the given position.
     * If limit > start then match forward from start+1 to limit
     * matching all characters except s.charAt(0).  If limit < start,
     * go backward starting from start-1 matching all characters
     * except s.charAt(s.length()-1).  This method assumes that the
     * first character, text.charAt(start), matches s, so it does not
     * check it.
     * @param text the text to match
     * @param start the first character to match.  In the forward
     * direction, text.charAt(start) is matched against s.charAt(0).
     * In the reverse direction, it is matched against
     * s.charAt(s.length()-1).
     * @param limit the limit offset for matching, either last+1 in
     * the forward direction, or last-1 in the reverse direction,
     * where last is the index of the last character to match.
     * @param s
     * @return If part of s matches up to the limit, return |limit -
     * start|.  If all of s matches before reaching the limit, return
     * s.length().  If there is a mismatch between s and text, return
     * 0
     */
    static int32_t matchRest(const Replaceable& text,
                             int32_t start, int32_t limit,
                             const UnicodeString& s);

    /**
     * Returns the smallest value i such that c < list[i].  Caller
     * must ensure that c is a legal value or this method will enter
     * an infinite loop.  This method performs a binary search.
     * @param c a character in the range MIN_VALUE..MAX_VALUE
     * inclusive
     * @return the smallest integer i in the range 0..len-1,
     * inclusive, such that c < list[i]
     */
    int32_t findCodePoint(UChar32 c) const;

public:

    /**
     * Implementation of UnicodeMatcher API.  Union the set of all
     * characters that may be matched by this object into the given
     * set.
     * @param toUnionTo the set into which to union the source characters
     * @stable ICU 2.4
     */
    virtual void addMatchSetTo(UnicodeSet& toUnionTo) const override;

    /**
     * Returns the index of the given character within this set, where
     * the set is ordered by ascending code point.  If the character
     * is not in this set, return -1.  The inverse of this method is
     * <code>charAt()</code>.
     * @return an index from 0..size()-1, or -1
     * @stable ICU 2.4
     */
    int32_t indexOf(UChar32 c) const;

    /**
     * Returns the character at the given index within this set, where
     * the set is ordered by ascending code point.  If the index is
     * out of range for characters, returns (UChar32)-1.
     * The inverse of this method is <code>indexOf()</code>.
     *
     * For iteration, this is slower than UnicodeSetIterator or
     * getRangeCount()/getRangeStart()/getRangeEnd(),
     * because for each call it skips linearly over <code>index</code>
     * characters in the ranges.
     *
     * @param index an index from 0..size()-1
     * @return the character at the given index, or (UChar32)-1.
     * @stable ICU 2.4
     */
    UChar32 charAt(int32_t index) const;

    /**
     * Returns a C++ "range" for iterating over the code points of this set.
     *
     * \code
     * UnicodeSet set(u"[abcçカ🚴]", errorCode);
     * for (UChar32 c : set.codePoints()) {
     *     printf("set.codePoint U+%04lx\n", (long)c);
     * }
     * \endcode
     *
     * @return a "range" object for iterating over the code points of this set.
     * @stable ICU 76
     * @see ranges
     * @see strings
     * @see begin
     * @see end
     */
    inline U_HEADER_NESTED_NAMESPACE::USetCodePoints codePoints() const {
        return U_HEADER_NESTED_NAMESPACE::USetCodePoints(toUSet());
    }

    /**
     * Returns a C++ "range" for iterating over the code point ranges of this set.
     *
     * \code
     * UnicodeSet set(u"[abcçカ🚴]", errorCode);
     * for (auto [start, end] : set.ranges()) {
     *     printf("set.range U+%04lx..U+%04lx\n", (long)start, (long)end);
     * }
     * for (auto range : set.ranges()) {
     *     for (UChar32 c : range) {
     *         printf("set.range.c U+%04lx\n", (long)c);
     *     }
     * }
     * \endcode
     *
     * @return a "range" object for iterating over the code point ranges of this set.
     * @stable ICU 76
     * @see codePoints
     * @see strings
     * @see begin
     * @see end
     */
    inline U_HEADER_NESTED_NAMESPACE::USetRanges ranges() const {
        return U_HEADER_NESTED_NAMESPACE::USetRanges(toUSet());
    }

    /**
     * Returns a C++ "range" for iterating over the empty and multi-character strings of this set.
     * Returns each string as a std::u16string_view without copying its contents.
     *
     * \code
     * UnicodeSet set(u"[abcçカ🚴{}{abc}{de}]", errorCode);
     * for (auto s : set.strings()) {
     *     UnicodeString us(s);
     *     std::string u8;
     *     printf("set.string length %ld \"%s\"\n", (long)s.length(), us.toUTF8String(u8).c_str());
     * }
     * \endcode
     *
     * @return a "range" object for iterating over the strings of this set.
     * @stable ICU 76
     * @see codePoints
     * @see ranges
     * @see begin
     * @see end
     */
    inline U_HEADER_NESTED_NAMESPACE::USetStrings strings() const {
        return U_HEADER_NESTED_NAMESPACE::USetStrings(toUSet());
    }

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns a C++ iterator for iterating over all of the elements of this set.
     * Convenient all-in one iteration, but creates a std::u16string for each
     * code point or string.
     * (Similar to how Java UnicodeSet *is an* Iterable&lt;String&gt;.)
     *
     * Code points are returned first, then empty and multi-character strings.
     *
     * \code
     * UnicodeSet set(u"[abcçカ🚴{}{abc}{de}]", errorCode);
     * for (auto el : set) {
     *     UnicodeString us(el);
     *     std::string u8;
     *     printf("set.element length %ld \"%s\"\n", (long)us.length(), us.toUTF8String(u8).c_str());
     * }
     * \endcode
     *
     * @return an all-elements iterator.
     * @draft ICU 77
     * @see end
     * @see codePoints
     * @see ranges
     * @see strings
     */
    inline U_HEADER_NESTED_NAMESPACE::USetElementIterator begin() const {
        return U_HEADER_NESTED_NAMESPACE::USetElements(toUSet()).begin();
    }

    /**
     * @return an exclusive-end sentinel for iterating over all of the elements of this set.
     * @draft ICU 77
     * @see begin
     * @see codePoints
     * @see ranges
     * @see strings
     */
    inline U_HEADER_NESTED_NAMESPACE::USetElementIterator end() const {
        return U_HEADER_NESTED_NAMESPACE::USetElements(toUSet()).end();
    }
#endif  // U_HIDE_DRAFT_API

    /**
     * Adds the specified range to this set if it is not already
     * present.  If this set already contains the specified range,
     * the call leaves this set unchanged.  If <code>start > end</code>
     * then an empty range is added, leaving the set unchanged.
     * This is equivalent to a boolean logic OR, or a set UNION.
     * A frozen set will not be modified.
     *
     * @param start first character, inclusive, of range to be added
     * to this set.
     * @param end last character, inclusive, of range to be added
     * to this set.
     * @stable ICU 2.0
     */
    UnicodeSet& add(UChar32 start, UChar32 end);

    /**
     * Adds the specified character to this set if it is not already
     * present.  If this set already contains the specified character,
     * the call leaves this set unchanged.
     * A frozen set will not be modified.
     *
     * @param c the character (code point)
     * @return this object, for chaining
     * @stable ICU 2.0
     */
    UnicodeSet& add(UChar32 c);

    /**
     * Adds the specified multicharacter to this set if it is not already
     * present.  If this set already contains the multicharacter,
     * the call leaves this set unchanged.
     * Thus "ch" => {"ch"}
     * A frozen set will not be modified.
     *
     * @param s the source string
     * @return this object, for chaining
     * @stable ICU 2.4
     */
    UnicodeSet& add(const UnicodeString& s);

 private:
    /**
     * @return a code point IF the string consists of a single one.
     * otherwise returns -1.
     * @param s string to test
     */
    static int32_t getSingleCP(const UnicodeString& s);

    void _add(const UnicodeString& s);

 public:
    /**
     * Adds each of the characters in this string to the set. Note: "ch" => {"c", "h"}
     * If this set already contains any particular character, it has no effect on that character.
     * A frozen set will not be modified.
     * @param s the source string
     * @return this object, for chaining
     * @stable ICU 2.4
     */
    UnicodeSet& addAll(const UnicodeString& s);

    /**
     * Retains EACH of the characters in this string. Note: "ch" == {"c", "h"}
     * A frozen set will not be modified.
     * @param s the source string
     * @return this object, for chaining
     * @stable ICU 2.4
     */
    UnicodeSet& retainAll(const UnicodeString& s);

    /**
     * Complement EACH of the characters in this string. Note: "ch" == {"c", "h"}
     * A frozen set will not be modified.
     * @param s the source string
     * @return this object, for chaining
     * @stable ICU 2.4
     */
    UnicodeSet& complementAll(const UnicodeString& s);

    /**
     * Remove EACH of the characters in this string. Note: "ch" == {"c", "h"}
     * A frozen set will not be modified.
     * @param s the source string
     * @return this object, for chaining
     * @stable ICU 2.4
     */
    UnicodeSet& removeAll(const UnicodeString& s);

    /**
     * Makes a set from a multicharacter string. Thus "ch" => {"ch"}
     *
     * @param s the source string
     * @return a newly created set containing the given string.
     * The caller owns the return object and is responsible for deleting it.
     * @stable ICU 2.4
     */
    static UnicodeSet* U_EXPORT2 createFrom(const UnicodeString& s);


    /**
     * Makes a set from each of the characters in the string. Thus "ch" => {"c", "h"}
     * @param s the source string
     * @return a newly created set containing the given characters
     * The caller owns the return object and is responsible for deleting it.
     * @stable ICU 2.4
     */
    static UnicodeSet* U_EXPORT2 createFromAll(const UnicodeString& s);

    /**
     * Retain only the elements in this set that are contained in the
     * specified range.  If <code>start > end</code> then an empty range is
     * retained, leaving the set empty.  This is equivalent to
     * a boolean logic AND, or a set INTERSECTION.
     * A frozen set will not be modified.
     *
     * @param start first character, inclusive, of range
     * @param end last character, inclusive, of range
     * @stable ICU 2.0
     */
    UnicodeSet& retain(UChar32 start, UChar32 end);


    /**
     * Retain the specified character from this set if it is present.
     * A frozen set will not be modified.
     *
     * @param c the character (code point)
     * @return this object, for chaining
     * @stable ICU 2.0
     */
    UnicodeSet& retain(UChar32 c);

    /**
     * Retains only the specified string from this set if it is present.
     * Upon return this set will be empty if it did not contain s, or
     * will only contain s if it did contain s.
     * A frozen set will not be modified.
     *
     * @param s the source string
     * @return this object, for chaining
     * @stable ICU 69
     */
    UnicodeSet& retain(const UnicodeString &s);

    /**
     * Removes the specified range from this set if it is present.
     * The set will not contain the specified range once the call
     * returns.  If <code>start > end</code> then an empty range is
     * removed, leaving the set unchanged.
     * A frozen set will not be modified.
     *
     * @param start first character, inclusive, of range to be removed
     * from this set.
     * @param end last character, inclusive, of range to be removed
     * from this set.
     * @stable ICU 2.0
     */
    UnicodeSet& remove(UChar32 start, UChar32 end);

    /**
     * Removes the specified character from this set if it is present.
     * The set will not contain the specified range once the call
     * returns.
     * A frozen set will not be modified.
     *
     * @param c the character (code point)
     * @return this object, for chaining
     * @stable ICU 2.0
     */
    UnicodeSet& remove(UChar32 c);

    /**
     * Removes the specified string from this set if it is present.
     * The set will not contain the specified character once the call
     * returns.
     * A frozen set will not be modified.
     * @param s the source string
     * @return this object, for chaining
     * @stable ICU 2.4
     */
    UnicodeSet& remove(const UnicodeString& s);

    /**
     * This is equivalent to
     * <code>complement(MIN_VALUE, MAX_VALUE)</code>.
     *
     * <strong>Note:</strong> This performs a symmetric difference with all code points
     * <em>and thus retains all multicharacter strings</em>.
     * In order to achieve a “code point complement” (all code points minus this set),
     * the easiest is to <code>.complement().removeAllStrings()</code>.
     *
     * A frozen set will not be modified.
     * @stable ICU 2.0
     */
    UnicodeSet& complement();

    /**
     * Complements the specified range in this set.  Any character in
     * the range will be removed if it is in this set, or will be
     * added if it is not in this set.  If <code>start > end</code>
     * then an empty range is complemented, leaving the set unchanged.
     * This is equivalent to a boolean logic XOR.
     * A frozen set will not be modified.
     *
     * @param start first character, inclusive, of range
     * @param end last character, inclusive, of range
     * @stable ICU 2.0
     */
    UnicodeSet& complement(UChar32 start, UChar32 end);

    /**
     * Complements the specified character in this set.  The character
     * will be removed if it is in this set, or will be added if it is
     * not in this set.
     * A frozen set will not be modified.
     *
     * @param c the character (code point)
     * @return this object, for chaining
     * @stable ICU 2.0
     */
    UnicodeSet& complement(UChar32 c);

    /**
     * Complement the specified string in this set.
     * The string will be removed if it is in this set, or will be added if it is not in this set.
     * A frozen set will not be modified.
     *
     * @param s the string to complement
     * @return this object, for chaining
     * @stable ICU 2.4
     */
    UnicodeSet& complement(const UnicodeString& s);

    /**
     * Adds all of the elements in the specified set to this set if
     * they're not already present.  This operation effectively
     * modifies this set so that its value is the <i>union</i> of the two
     * sets.  The behavior of this operation is unspecified if the specified
     * collection is modified while the operation is in progress.
     * A frozen set will not be modified.
     *
     * @param c set whose elements are to be added to this set.
     * @see #add(UChar32, UChar32)
     * @stable ICU 2.0
     */
    UnicodeSet& addAll(const UnicodeSet& c);

    /**
     * Retains only the elements in this set that are contained in the
     * specified set.  In other words, removes from this set all of
     * its elements that are not contained in the specified set.  This
     * operation effectively modifies this set so that its value is
     * the <i>intersection</i> of the two sets.
     * A frozen set will not be modified.
     *
     * @param c set that defines which elements this set will retain.
     * @stable ICU 2.0
     */
    UnicodeSet& retainAll(const UnicodeSet& c);

    /**
     * Removes from this set all of its elements that are contained in the
     * specified set.  This operation effectively modifies this
     * set so that its value is the <i>asymmetric set difference</i> of
     * the two sets.
     * A frozen set will not be modified.
     *
     * @param c set that defines which elements will be removed from
     *          this set.
     * @stable ICU 2.0
     */
    UnicodeSet& removeAll(const UnicodeSet& c);

    /**
     * Complements in this set all elements contained in the specified
     * set.  Any character in the other set will be removed if it is
     * in this set, or will be added if it is not in this set.
     * A frozen set will not be modified.
     *
     * @param c set that defines which elements will be xor'ed from
     *          this set.
     * @stable ICU 2.4
     */
    UnicodeSet& complementAll(const UnicodeSet& c);

    /**
     * Removes all of the elements from this set.  This set will be
     * empty after this call returns.
     * A frozen set will not be modified.
     * @stable ICU 2.0
     */
    UnicodeSet& clear();

    /**
     * Close this set over the given attribute.  For the attribute
     * USET_CASE_INSENSITIVE, the result is to modify this set so that:
     *
     * 1. For each character or string 'a' in this set, all strings or
     * characters 'b' such that foldCase(a) == foldCase(b) are added
     * to this set.
     *
     * 2. For each string 'e' in the resulting set, if e !=
     * foldCase(e), 'e' will be removed.
     *
     * Example: [aq\\u00DF{Bc}{bC}{Fi}] => [aAqQ\\u00DF\\uFB01{ss}{bc}{fi}]
     *
     * (Here foldCase(x) refers to the operation u_strFoldCase, and a
     * == b denotes that the contents are the same, not pointer
     * comparison.)
     *
     * A frozen set will not be modified.
     *
     * @param attribute bitmask for attributes to close over.
     * Valid options:
     * At most one of USET_CASE_INSENSITIVE, USET_ADD_CASE_MAPPINGS, USET_SIMPLE_CASE_INSENSITIVE.
     * These case options are mutually exclusive.
     * Unrelated options bits are ignored.
     * @return a reference to this set.
     * @stable ICU 4.2
     */
    UnicodeSet& closeOver(int32_t attribute);

    /**
     * Remove all strings from this set.
     *
     * @return a reference to this set.
     * @stable ICU 4.2
     */
    UnicodeSet &removeAllStrings();

    /**
     * Iteration method that returns the number of ranges contained in
     * this set.
     * @see #getRangeStart
     * @see #getRangeEnd
     * @stable ICU 2.4
     */
    int32_t getRangeCount() const;

    /**
     * Iteration method that returns the first character in the
     * specified range of this set.
     * @see #getRangeCount
     * @see #getRangeEnd
     * @stable ICU 2.4
     */
    UChar32 getRangeStart(int32_t index) const;

    /**
     * Iteration method that returns the last character in the
     * specified range of this set.
     * @see #getRangeStart
     * @see #getRangeEnd
     * @stable ICU 2.4
     */
    UChar32 getRangeEnd(int32_t index) const;

    /**
     * Serializes this set into an array of 16-bit integers.  Serialization
     * (currently) only records the characters in the set; multicharacter
     * strings are ignored.
     *
     * The array has following format (each line is one 16-bit
     * integer):
     *
     *  length     = (n+2*m) | (m!=0?0x8000:0)
     *  bmpLength  = n; present if m!=0
     *  bmp[0]
     *  bmp[1]
     *  ...
     *  bmp[n-1]
     *  supp-high[0]
     *  supp-low[0]
     *  supp-high[1]
     *  supp-low[1]
     *  ...
     *  supp-high[m-1]
     *  supp-low[m-1]
     *
     * The array starts with a header.  After the header are n bmp
     * code points, then m supplementary code points.  Either n or m
     * or both may be zero.  n+2*m is always <= 0x7FFF.
     *
     * If there are no supplementary characters (if m==0) then the
     * header is one 16-bit integer, 'length', with value n.
     *
     * If there are supplementary characters (if m!=0) then the header
     * is two 16-bit integers.  The first, 'length', has value
     * (n+2*m)|0x8000.  The second, 'bmpLength', has value n.
     *
     * After the header the code points are stored in ascending order.
     * Supplementary code points are stored as most significant 16
     * bits followed by least significant 16 bits.
     *
     * @param dest pointer to buffer of destCapacity 16-bit integers.
     * May be nullptr only if destCapacity is zero.
     * @param destCapacity size of dest, or zero.  Must not be negative.
     * @param ec error code.  Will be set to U_INDEX_OUTOFBOUNDS_ERROR
     * if n+2*m > 0x7FFF.  Will be set to U_BUFFER_OVERFLOW_ERROR if
     * n+2*m+(m!=0?2:1) > destCapacity.
     * @return the total length of the serialized format, including
     * the header, that is, n+2*m+(m!=0?2:1), or 0 on error other
     * than U_BUFFER_OVERFLOW_ERROR.
     * @stable ICU 2.4
     */
    int32_t serialize(uint16_t *dest, int32_t destCapacity, UErrorCode& ec) const;

    /**
     * Reallocate this objects internal structures to take up the least
     * possible space, without changing this object's value.
     * A frozen set will not be modified.
     * @stable ICU 2.4
     */
    UnicodeSet& compact();

    /**
     * Return the class ID for this class.  This is useful only for
     * comparing to a return value from getDynamicClassID().  For example:
     * <pre>
     * .      Base* polymorphic_pointer = createPolymorphicObject();
     * .      if (polymorphic_pointer->getDynamicClassID() ==
     * .          Derived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Implement UnicodeFunctor API.
     *
     * @return The class ID for this object. All objects of a given
     * class have the same class ID.  Objects of other classes have
     * different class IDs.
     * @stable ICU 2.4
     */
    virtual UClassID getDynamicClassID() const override;

  private:

    // Private API for the USet API

    friend class USetAccess;

    const UnicodeString* getString(int32_t index) const;

    //----------------------------------------------------------------
    // RuleBasedTransliterator support
    //----------------------------------------------------------------

private:

    /**
     * Returns <tt>true</tt> if this set contains any character whose low byte
     * is the given value.  This is used by <tt>RuleBasedTransliterator</tt> for
     * indexing.
     */
    virtual UBool matchesIndexValue(uint8_t v) const override;

private:
    friend class RBBIRuleScanner;

    //----------------------------------------------------------------
    // Implementation: Clone as thawed (see ICU4J Freezable)
    //----------------------------------------------------------------

    UnicodeSet(const UnicodeSet& o, UBool /* asThawed */);
    UnicodeSet& copyFrom(const UnicodeSet& o, UBool asThawed);

    //----------------------------------------------------------------
    // Implementation: Pattern parsing
    //----------------------------------------------------------------

    void applyPatternIgnoreSpace(const UnicodeString& pattern,
                                 ParsePosition& pos,
                                 const SymbolTable* symbols,
                                 UErrorCode& status);

    void applyPattern(RuleCharacterIterator& chars,
                      const SymbolTable* symbols,
                      UnicodeString& rebuiltPat,
                      uint32_t options,
                      UnicodeSet& (UnicodeSet::*caseClosure)(int32_t attribute),
                      int32_t depth,
                      UErrorCode& ec);

    void closeOverCaseInsensitive(bool simple);
    void closeOverAddCaseMappings();

    //----------------------------------------------------------------
    // Implementation: Utility methods
    //----------------------------------------------------------------

    static int32_t nextCapacity(int32_t minCapacity);

    bool ensureCapacity(int32_t newLen);

    bool ensureBufferCapacity(int32_t newLen);

    void swapBuffers();

    UBool allocateStrings(UErrorCode &status);
    int32_t stringsSize() const;
    UBool stringsContains(const UnicodeString &s) const;

    UnicodeString& _toPattern(UnicodeString& result,
                              UBool escapeUnprintable) const;

    UnicodeString& _generatePattern(UnicodeString& result,
                                    UBool escapeUnprintable) const;

    static void _appendToPat(UnicodeString& buf, const UnicodeString& s, UBool escapeUnprintable);

    static void _appendToPat(UnicodeString& buf, UChar32 c, UBool escapeUnprintable);

    static void _appendToPat(UnicodeString &result, UChar32 start, UChar32 end,
                             UBool escapeUnprintable);

    //----------------------------------------------------------------
    // Implementation: Fundamental operators
    //----------------------------------------------------------------

    void exclusiveOr(const UChar32* other, int32_t otherLen, int8_t polarity);

    void add(const UChar32* other, int32_t otherLen, int8_t polarity);

    void retain(const UChar32* other, int32_t otherLen, int8_t polarity);

    /**
     * Return true if the given position, in the given pattern, appears
     * to be the start of a property set pattern [:foo:], \\p{foo}, or
     * \\P{foo}, or \\N{name}.
     */
    static UBool resemblesPropertyPattern(const UnicodeString& pattern,
                                          int32_t pos);

    static UBool resemblesPropertyPattern(RuleCharacterIterator& chars,
                                          int32_t iterOpts);

    /**
     * Parse the given property pattern at the given parse position
     * and set this UnicodeSet to the result.
     *
     * The original design document is out of date, but still useful.
     * Ignore the property and value names:
     * https://htmlpreview.github.io/?https://github.com/unicode-org/icu-docs/blob/main/design/unicodeset_properties.html
     *
     * Recognized syntax:
     *
     * [:foo:] [:^foo:] - white space not allowed within "[:" or ":]"
     * \\p{foo} \\P{foo}  - white space not allowed within "\\p" or "\\P"
     * \\N{name}         - white space not allowed within "\\N"
     *
     * Other than the above restrictions, Unicode Pattern_White_Space characters are ignored.
     * Case is ignored except in "\\p" and "\\P" and "\\N".  In 'name' leading
     * and trailing space is deleted, and internal runs of whitespace
     * are collapsed to a single space.
     *
     * We support binary properties, enumerated properties, and the
     * following non-enumerated properties:
     *
     *  Numeric_Value
     *  Name
     *  Unicode_1_Name
     *
     * @param pattern the pattern string
     * @param ppos on entry, the position at which to begin parsing.
     * This should be one of the locations marked '^':
     *
     *   [:blah:]     \\p{blah}     \\P{blah}     \\N{name}
     *   ^       %    ^       %    ^       %    ^       %
     *
     * On return, the position after the last character parsed, that is,
     * the locations marked '%'.  If the parse fails, ppos is returned
     * unchanged.
     * @param ec status
     * @return a reference to this.
     */
    UnicodeSet& applyPropertyPattern(const UnicodeString& pattern,
                                     ParsePosition& ppos,
                                     UErrorCode &ec);

    void applyPropertyPattern(RuleCharacterIterator& chars,
                              UnicodeString& rebuiltPat,
                              UErrorCode& ec);

    /**
     * A filter that returns true if the given code point should be
     * included in the UnicodeSet being constructed.
     */
    typedef UBool (*Filter)(UChar32 codePoint, void* context);

    /**
     * Given a filter, set this UnicodeSet to the code points
     * contained by that filter.  The filter MUST be
     * property-conformant.  That is, if it returns value v for one
     * code point, then it must return v for all affiliated code
     * points, as defined by the inclusions list.  See
     * getInclusions().
     * src is a UPropertySource value.
     */
    void applyFilter(Filter filter,
                     void* context,
                     const UnicodeSet* inclusions,
                     UErrorCode &status);

    /**
     * Set the new pattern to cache.
     */
    void setPattern(const UnicodeString& newPat) {
        setPattern(newPat.getBuffer(), newPat.length());
    }
    void setPattern(const char16_t *newPat, int32_t newPatLen);
    /**
     * Release existing cached pattern.
     */
    void releasePattern();

    friend class UnicodeSetIterator;
};



inline bool UnicodeSet::operator!=(const UnicodeSet& o) const {
    return !operator==(o);
}

inline UBool UnicodeSet::isFrozen() const {
    return bmpSet != nullptr || stringSpan != nullptr;
}

inline UBool UnicodeSet::containsSome(UChar32 start, UChar32 end) const {
    return !containsNone(start, end);
}

inline UBool UnicodeSet::containsSome(const UnicodeSet& s) const {
    return !containsNone(s);
}

inline UBool UnicodeSet::containsSome(const UnicodeString& s) const {
    return !containsNone(s);
}

inline UBool UnicodeSet::isBogus() const {
    return fFlags & kIsBogus;
}

inline UnicodeSet *UnicodeSet::fromUSet(USet *uset) {
    return reinterpret_cast<UnicodeSet *>(uset);
}

inline const UnicodeSet *UnicodeSet::fromUSet(const USet *uset) {
    return reinterpret_cast<const UnicodeSet *>(uset);
}

inline USet *UnicodeSet::toUSet() {
    return reinterpret_cast<USet *>(this);
}

inline const USet *UnicodeSet::toUSet() const {
    return reinterpret_cast<const USet *>(this);
}

inline int32_t UnicodeSet::span(const UnicodeString &s, int32_t start, USetSpanCondition spanCondition) const {
    int32_t sLength=s.length();
    if(start<0) {
        start=0;
    } else if(start>sLength) {
        start=sLength;
    }
    return start+span(s.getBuffer()+start, sLength-start, spanCondition);
}

inline int32_t UnicodeSet::spanBack(const UnicodeString &s, int32_t limit, USetSpanCondition spanCondition) const {
    int32_t sLength=s.length();
    if(limit<0) {
        limit=0;
    } else if(limit>sLength) {
        limit=sLength;
    }
    return spanBack(s.getBuffer(), limit, spanCondition);
}

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
