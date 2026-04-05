// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
***************************************************************************
*   Copyright (C) 1999-2016 International Business Machines Corporation   *
*   and others. All rights reserved.                                      *
***************************************************************************

**********************************************************************
*   Date        Name        Description
*   10/22/99    alan        Creation.
*   11/11/99    rgillam     Complete port from Java.
**********************************************************************
*/

#ifndef RBBI_H
#define RBBI_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Rule Based Break Iterator
 */

#if !UCONFIG_NO_BREAK_ITERATION

#include "unicode/brkiter.h"
#include "unicode/udata.h"
#include "unicode/parseerr.h"
#include "unicode/schriter.h"

struct UCPTrie;

U_NAMESPACE_BEGIN

/** @internal */
class  LanguageBreakEngine;
struct RBBIDataHeader;
class  RBBIDataWrapper;
class  UnhandledEngine;
class  UStack;


#ifndef U_HIDE_INTERNAL_API
/**
 * The ExternalBreakEngine class define an abstract interface for the host environment
 * to provide a low level facility to break text for unicode text in script that the text boundary
 * cannot be handled by upper level rule based logic, for example, for Chinese and Japanese
 * word breaking, Thai, Khmer, Burmese, Lao and other Southeast Asian scripts.
 * The host environment implement one or more subclass of ExternalBreakEngine and
 * register them in the initialization time by calling
 * RuleBasedBreakIterator::registerExternalBreakEngine(). ICU adopt and own the engine and will
 * delete the registered external engine in proper time during the clean up
 * event.
 * @internal ICU 74 technology preview
 */
class ExternalBreakEngine : public UObject {
  public:
    /**
     * destructor
     * @internal ICU 74 technology preview
     */
    virtual ~ExternalBreakEngine() {}

    /**
     * <p>Indicate whether this engine handles a particular character when
     * the RuleBasedBreakIterator is used for a particular locale. This method is used
     * by the RuleBasedBreakIterator to find a break engine.</p>
     * @param c A character which begins a run that the engine might handle.
     * @param locale    The locale.
     * @return true if this engine handles the particular character for that locale.
     * @internal ICU 74 technology preview
     */
    virtual bool isFor(UChar32 c, const char* locale) const = 0;

    /**
     * <p>Indicate whether this engine handles a particular character.This method is
     * used by the RuleBasedBreakIterator after it already find a break engine to see which
     * characters after the first one can be handled by this break engine.</p>
     * @param c A character that the engine might handle.
     * @return true if this engine handles the particular character.
     * @internal ICU 74 technology preview
     */
    virtual bool handles(UChar32 c) const = 0;

    /**
     * <p>Divide up a range of text handled by this break engine.</p>
     *
     * @param text A UText representing the text
     * @param start The start of the range of known characters
     * @param end The end of the range of known characters
     * @param foundBreaks Output of C array of int32_t break positions, or
     * nullptr
     * @param foundBreaksCapacity The capacity of foundBreaks
     * @param status Information on any errors encountered.
     * @return The number of breaks found
     * @internal ICU 74 technology preview
     */
     virtual int32_t fillBreaks(UText* text,  int32_t start, int32_t end,
                               int32_t* foundBreaks, int32_t foundBreaksCapacity,
                               UErrorCode& status) const = 0;
};
#endif  /* U_HIDE_INTERNAL_API */


/**
 *
 * A subclass of BreakIterator whose behavior is specified using a list of rules.
 * <p>Instances of this class are most commonly created by the factory methods of
 *  BreakIterator::createWordInstance(), BreakIterator::createLineInstance(), etc.,
 *  and then used via the abstract API in class BreakIterator</p>
 *
 * <p>See the ICU User Guide for information on Break Iterator Rules.</p>
 *
 * <p>This class is not intended to be subclassed.</p>
 */
class U_COMMON_API RuleBasedBreakIterator /*final*/ : public BreakIterator {

private:
    /**
     * The UText through which this BreakIterator accesses the text
     */
    UText  fText = UTEXT_INITIALIZER;

#ifndef U_HIDE_INTERNAL_API
public:
#endif /* U_HIDE_INTERNAL_API */
    /**
     * The rule data for this BreakIterator instance.
     * Not for general use; Public only for testing purposes.
     * @internal
     */
    RBBIDataWrapper    *fData = nullptr;

private:
    /**
      * The saved error code associated with this break iterator.
      * This is the value to be returned by copyErrorTo().
      */
    UErrorCode      fErrorCode = U_ZERO_ERROR;

    /**
      * The current  position of the iterator. Pinned, 0 < fPosition <= text.length.
      * Never has the value UBRK_DONE (-1).
      */
    int32_t         fPosition = 0;

    /**
      * TODO:
      */
    int32_t         fRuleStatusIndex = 0;

    /**
     *   Cache of previously determined boundary positions.
     */
    class BreakCache;
    BreakCache         *fBreakCache = nullptr;

    /**
     *  Cache of boundary positions within a region of text that has been
     *  sub-divided by dictionary based breaking.
     */
    class DictionaryCache;
    DictionaryCache *fDictionaryCache = nullptr;

    /**
     *
     * If present, UStack of LanguageBreakEngine objects that might handle
     * dictionary characters. Searched from top to bottom to find an object to
     * handle a given character.
     */
    UStack              *fLanguageBreakEngines = nullptr;

    /**
     *
     * If present, the special LanguageBreakEngine used for handling
     * characters that are in the dictionary set, but not handled by any
     * LanguageBreakEngine.
     */
    UnhandledEngine     *fUnhandledBreakEngine = nullptr;

    /**
     * Counter for the number of characters encountered with the "dictionary"
     *   flag set.
     */
    uint32_t            fDictionaryCharCount = 0;

    /**
     *   A character iterator that refers to the same text as the UText, above.
     *   Only included for compatibility with old API, which was based on CharacterIterators.
     *   Value may be adopted from outside, or one of fSCharIter or fDCharIter, below.
     */
    CharacterIterator  *fCharIter = &fSCharIter;

    /**
     *   When the input text is provided by a UnicodeString, this will point to
     *    a characterIterator that wraps that data.  Needed only for the
     *    implementation of getText(), a backwards compatibility issue.
     */
    UCharCharacterIterator fSCharIter {u"", 0};

    /**
      * True when iteration has run off the end, and iterator functions should return UBRK_DONE.
      */
    bool           fDone = false;

    /**
     *  Array of look-ahead tentative results.
     */
    int32_t *fLookAheadMatches = nullptr;

    /**
     *  A flag to indicate if phrase based breaking is enabled.
     */
    UBool fIsPhraseBreaking = false;

    //=======================================================================
    // constructors
    //=======================================================================

    /**
     * Constructor from a flattened set of RBBI data in malloced memory.
     *             RulesBasedBreakIterators built from a custom set of rules
     *             are created via this constructor; the rules are compiled
     *             into memory, then the break iterator is constructed here.
     *
     *             The break iterator adopts the memory, and will
     *             free it when done.
     */
    RuleBasedBreakIterator(RBBIDataHeader* data, UErrorCode &status);

    /**
     * This constructor uses the udata interface to create a BreakIterator
     * whose internal tables live in a memory-mapped file.  "image" is an
     * ICU UDataMemory handle for the pre-compiled break iterator tables.
     * @param image handle to the memory image for the break iterator data.
     *        Ownership of the UDataMemory handle passes to the Break Iterator,
     *        which will be responsible for closing it when it is no longer needed.
     * @param status Information on any errors encountered.
     * @param isPhraseBreaking true if phrase based breaking is required, otherwise false.
     * @see udata_open
     * @see #getBinaryRules
     */
    RuleBasedBreakIterator(UDataMemory* image, UBool isPhraseBreaking, UErrorCode &status);

    friend class RBBIRuleBuilder;
    friend class BreakIterator;

    /**
     * Default constructor with an error code parameter.
     * Aside from error handling, otherwise identical to the default constructor.
     * Internally, handles common initialization for other constructors.
     */
    RuleBasedBreakIterator(UErrorCode *status);

public:

    /** Default constructor.  Creates an empty shell of an iterator, with no
     *  rules or text to iterate over.   Object can subsequently be assigned to,
     *  but is otherwise unusable.
     *  @stable ICU 2.2
     */
    RuleBasedBreakIterator();

    /**
     * Copy constructor.  Will produce a break iterator with the same behavior,
     * and which iterates over the same text, as the one passed in.
     * @param that The RuleBasedBreakIterator passed to be copied
     * @stable ICU 2.0
     */
    RuleBasedBreakIterator(const RuleBasedBreakIterator& that);

    /**
     * Construct a RuleBasedBreakIterator from a set of rules supplied as a string.
     * @param rules The break rules to be used.
     * @param parseError  In the event of a syntax error in the rules, provides the location
     *                    within the rules of the problem.
     * @param status Information on any errors encountered.
     * @stable ICU 2.2
     */
    RuleBasedBreakIterator( const UnicodeString    &rules,
                             UParseError           &parseError,
                             UErrorCode            &status);

    /**
     * Construct a RuleBasedBreakIterator from a set of precompiled binary rules.
     * Binary rules are obtained from RulesBasedBreakIterator::getBinaryRules().
     * Construction of a break iterator in this way is substantially faster than
     * construction from source rules.
     *
     * Ownership of the storage containing the compiled rules remains with the
     * caller of this function.  The compiled rules must not be  modified or
     * deleted during the life of the break iterator.
     *
     * The compiled rules are not compatible across different major versions of ICU.
     * The compiled rules are compatible only between machines with the same
     * byte ordering (little or big endian) and the same base character set family
     * (ASCII or EBCDIC).
     *
     * @see #getBinaryRules
     * @param compiledRules A pointer to the compiled break rules to be used.
     * @param ruleLength The length of the compiled break rules, in bytes.  This
     *   corresponds to the length value produced by getBinaryRules().
     * @param status Information on any errors encountered, including invalid
     *   binary rules.
     * @stable ICU 4.8
     */
    RuleBasedBreakIterator(const uint8_t *compiledRules,
                           uint32_t       ruleLength,
                           UErrorCode    &status);

    /**
     * This constructor uses the udata interface to create a BreakIterator
     * whose internal tables live in a memory-mapped file.  "image" is an
     * ICU UDataMemory handle for the pre-compiled break iterator tables.
     * @param image handle to the memory image for the break iterator data.
     *        Ownership of the UDataMemory handle passes to the Break Iterator,
     *        which will be responsible for closing it when it is no longer needed.
     * @param status Information on any errors encountered.
     * @see udata_open
     * @see #getBinaryRules
     * @stable ICU 2.8
     */
    RuleBasedBreakIterator(UDataMemory* image, UErrorCode &status);

    /**
     * Destructor
     *  @stable ICU 2.0
     */
    virtual ~RuleBasedBreakIterator();

    /**
     * Assignment operator.  Sets this iterator to have the same behavior,
     * and iterate over the same text, as the one passed in.
     * @param that The RuleBasedBreakItertor passed in
     * @return the newly created RuleBasedBreakIterator
     *  @stable ICU 2.0
     */
    RuleBasedBreakIterator& operator=(const RuleBasedBreakIterator& that);

    /**
     * Equality operator.  Returns true if both BreakIterators are of the
     * same class, have the same behavior, and iterate over the same text.
     * @param that The BreakIterator to be compared for equality
     * @return true if both BreakIterators are of the
     * same class, have the same behavior, and iterate over the same text.
     *  @stable ICU 2.0
     */
    virtual bool operator==(const BreakIterator& that) const override;

    /**
     * Not-equal operator.  If operator== returns true, this returns false,
     * and vice versa.
     * @param that The BreakIterator to be compared for inequality
     * @return true if both BreakIterators are not same.
     *  @stable ICU 2.0
     */
    inline bool operator!=(const BreakIterator& that) const {
        return !operator==(that);
    }

    /**
     * Returns a newly-constructed RuleBasedBreakIterator with the same
     * behavior, and iterating over the same text, as this one.
     * Differs from the copy constructor in that it is polymorphic, and
     * will correctly clone (copy) a derived class.
     * clone() is thread safe.  Multiple threads may simultaneously
     * clone the same source break iterator.
     * @return a newly-constructed RuleBasedBreakIterator
     * @stable ICU 2.0
     */
    virtual RuleBasedBreakIterator* clone() const override;

    /**
     * Compute a hash code for this BreakIterator
     * @return A hash code
     *  @stable ICU 2.0
     */
    virtual int32_t hashCode() const;

    /**
     * Returns the description used to create this iterator
     * @return the description used to create this iterator
     *  @stable ICU 2.0
     */
    virtual const UnicodeString& getRules() const;

    //=======================================================================
    // BreakIterator overrides
    //=======================================================================

    /**
     * <p>
     * Return a CharacterIterator over the text being analyzed.
     * The returned character iterator is owned by the break iterator, and must
     * not be deleted by the caller.  Repeated calls to this function may
     * return the same CharacterIterator.
     * </p>
     * <p>
     * The returned character iterator must not be used concurrently with
     * the break iterator.  If concurrent operation is needed, clone the
     * returned character iterator first and operate on the clone.
     * </p>
     * <p>
     * When the break iterator is operating on text supplied via a UText,
     * this function will fail, returning a CharacterIterator containing no text.
     * The function getUText() provides similar functionality,
     * is reliable, and is more efficient.
     * </p>
     *
     * TODO:  deprecate this function?
     *
     * @return An iterator over the text being analyzed.
     * @stable ICU 2.0
     */
    virtual CharacterIterator& getText() const override;

    /**
      *  Get a UText for the text being analyzed.
      *  The returned UText is a shallow clone of the UText used internally
      *  by the break iterator implementation.  It can safely be used to
      *  access the text without impacting any break iterator operations,
      *  but the underlying text itself must not be altered.
      *
      * @param fillIn A UText to be filled in.  If nullptr, a new UText will be
      *           allocated to hold the result.
      * @param status receives any error codes.
      * @return   The current UText for this break iterator.  If an input
      *           UText was provided, it will always be returned.
      * @stable ICU 3.4
      */
     virtual UText *getUText(UText *fillIn, UErrorCode &status) const override;

    /**
     * Set the iterator to analyze a new piece of text.  This function resets
     * the current iteration position to the beginning of the text.
     * @param newText An iterator over the text to analyze.  The BreakIterator
     * takes ownership of the character iterator.  The caller MUST NOT delete it!
     *  @stable ICU 2.0
     */
    virtual void adoptText(CharacterIterator* newText) override;

    /**
     * Set the iterator to analyze a new piece of text.  This function resets
     * the current iteration position to the beginning of the text.
     *
     * The BreakIterator will retain a reference to the supplied string.
     * The caller must not modify or delete the text while the BreakIterator
     * retains the reference.
     *
     * @param newText The text to analyze.
     *  @stable ICU 2.0
     */
    virtual void setText(const UnicodeString& newText) override;

    /**
     * Reset the break iterator to operate over the text represented by
     * the UText.  The iterator position is reset to the start.
     *
     * This function makes a shallow clone of the supplied UText.  This means
     * that the caller is free to immediately close or otherwise reuse the
     * Utext that was passed as a parameter, but that the underlying text itself
     * must not be altered while being referenced by the break iterator.
     *
     * @param text    The UText used to change the text.
     * @param status  Receives any error codes.
     * @stable ICU 3.4
     */
    virtual void  setText(UText *text, UErrorCode &status) override;

    /**
     * Sets the current iteration position to the beginning of the text, position zero.
     * @return The offset of the beginning of the text, zero.
     *  @stable ICU 2.0
     */
    virtual int32_t first() override;

    /**
     * Sets the current iteration position to the end of the text.
     * @return The text's past-the-end offset.
     *  @stable ICU 2.0
     */
    virtual int32_t last() override;

    /**
     * Advances the iterator either forward or backward the specified number of steps.
     * Negative values move backward, and positive values move forward.  This is
     * equivalent to repeatedly calling next() or previous().
     * @param n The number of steps to move.  The sign indicates the direction
     * (negative is backwards, and positive is forwards).
     * @return The character offset of the boundary position n boundaries away from
     * the current one.
     *  @stable ICU 2.0
     */
    virtual int32_t next(int32_t n) override;

    /**
     * Advances the iterator to the next boundary position.
     * @return The position of the first boundary after this one.
     *  @stable ICU 2.0
     */
    virtual int32_t next() override;

    /**
     * Moves the iterator backwards, to the last boundary preceding this one.
     * @return The position of the last boundary position preceding this one.
     *  @stable ICU 2.0
     */
    virtual int32_t previous() override;

    /**
     * Sets the iterator to refer to the first boundary position following
     * the specified position.
     * @param offset The position from which to begin searching for a break position.
     * @return The position of the first break after the current position.
     *  @stable ICU 2.0
     */
    virtual int32_t following(int32_t offset) override;

    /**
     * Sets the iterator to refer to the last boundary position before the
     * specified position.
     * @param offset The position to begin searching for a break from.
     * @return The position of the last boundary before the starting position.
     *  @stable ICU 2.0
     */
    virtual int32_t preceding(int32_t offset) override;

    /**
     * Returns true if the specified position is a boundary position.  As a side
     * effect, leaves the iterator pointing to the first boundary position at
     * or after "offset".
     * @param offset the offset to check.
     * @return True if "offset" is a boundary position.
     *  @stable ICU 2.0
     */
    virtual UBool isBoundary(int32_t offset) override;

    /**
     * Returns the current iteration position. Note that UBRK_DONE is never
     * returned from this function; if iteration has run to the end of a
     * string, current() will return the length of the string while
     * next() will return UBRK_DONE).
     * @return The current iteration position.
     * @stable ICU 2.0
     */
    virtual int32_t current() const override;

    /**
     * Return the status tag from the break rule that determined the boundary at
     * the current iteration position.  For break rules that do not specify a
     * status, a default value of 0 is returned.  If more than one break rule
     * would cause a boundary to be located at some position in the text,
     * the numerically largest of the applicable status values is returned.
     * <p>
     * Of the standard types of ICU break iterators, only word break and
     * line break provide status values.  The values are defined in
     * the header file ubrk.h.  For Word breaks, the status allows distinguishing between words
     * that contain alphabetic letters, "words" that appear to be numbers,
     * punctuation and spaces, words containing ideographic characters, and
     * more.  For Line Break, the status distinguishes between hard (mandatory) breaks
     * and soft (potential) break positions.
     * <p>
     * <code>getRuleStatus()</code> can be called after obtaining a boundary
     * position from <code>next()</code>, <code>previous()</code>, or
     * any other break iterator functions that returns a boundary position.
     * <p>
     * Note that <code>getRuleStatus()</code> returns the value corresponding to
     * <code>current()</code> index even after <code>next()</code> has returned DONE.
     * <p>
     * When creating custom break rules, one is free to define whatever
     * status values may be convenient for the application.
     * <p>
     * @return the status from the break rule that determined the boundary
     * at the current iteration position.
     *
     * @see UWordBreak
     * @stable ICU 2.2
     */
    virtual int32_t getRuleStatus() const override;

   /**
    * Get the status (tag) values from the break rule(s) that determined the boundary
    * at the current iteration position.
    * <p>
    * The returned status value(s) are stored into an array provided by the caller.
    * The values are stored in sorted (ascending) order.
    * If the capacity of the output array is insufficient to hold the data,
    *  the output will be truncated to the available length, and a
    *  U_BUFFER_OVERFLOW_ERROR will be signaled.
    *
    * @param fillInVec an array to be filled in with the status values.
    * @param capacity  the length of the supplied vector.  A length of zero causes
    *                  the function to return the number of status values, in the
    *                  normal way, without attempting to store any values.
    * @param status    receives error codes.
    * @return          The number of rule status values from the rules that determined
    *                  the boundary at the current iteration position.
    *                  In the event of a U_BUFFER_OVERFLOW_ERROR, the return value
    *                  is the total number of status values that were available,
    *                  not the reduced number that were actually returned.
    * @see getRuleStatus
    * @stable ICU 3.0
    */
    virtual int32_t getRuleStatusVec(int32_t *fillInVec, int32_t capacity, UErrorCode &status) override;

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
    virtual UClassID getDynamicClassID() const override;

    /**
     * Returns the class ID for this class.  This is useful only for
     * comparing to a return value from getDynamicClassID().  For example:
     *
     *      Base* polymorphic_pointer = createPolymorphicObject();
     *      if (polymorphic_pointer->getDynamicClassID() ==
     *          Derived::getStaticClassID()) ...
     *
     * @return          The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    static UClassID U_EXPORT2 getStaticClassID();

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Deprecated functionality. Use clone() instead.
     *
     * Create a clone (copy) of this break iterator in memory provided
     *  by the caller.  The idea is to increase performance by avoiding
     *  a storage allocation.  Use of this function is NOT RECOMMENDED.
     *  Performance gains are minimal, and correct buffer management is
     *  tricky.  Use clone() instead.
     *
     * @param stackBuffer  The pointer to the memory into which the cloned object
     *                     should be placed.  If nullptr,  allocate heap memory
     *                     for the cloned object.
     * @param BufferSize   The size of the buffer.  If zero, return the required
     *                     buffer size, but do not clone the object.  If the
     *                     size was too small (but not zero), allocate heap
     *                     storage for the cloned object.
     *
     * @param status       Error status.  U_SAFECLONE_ALLOCATED_WARNING will be
     *                     returned if the provided buffer was too small, and
     *                     the clone was therefore put on the heap.
     *
     * @return  Pointer to the clone object.  This may differ from the stackBuffer
     *          address if the byte alignment of the stack buffer was not suitable
     *          or if the stackBuffer was too small to hold the clone.
     * @deprecated ICU 52. Use clone() instead.
     */
    virtual RuleBasedBreakIterator *createBufferClone(void *stackBuffer,
                                                      int32_t &BufferSize,
                                                      UErrorCode &status) override;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Return the binary form of compiled break rules,
     * which can then be used to create a new break iterator at some
     * time in the future.  Creating a break iterator from pre-compiled rules
     * is much faster than building one from the source form of the
     * break rules.
     *
     * The binary data can only be used with the same version of ICU
     *  and on the same platform type (processor endian-ness)
     *
     * @param length Returns the length of the binary data.  (Out parameter.)
     *
     * @return   A pointer to the binary (compiled) rule data.  The storage
     *           belongs to the RulesBasedBreakIterator object, not the
     *           caller, and must not be modified or deleted.
     * @stable ICU 4.8
     */
    virtual const uint8_t *getBinaryRules(uint32_t &length);

    /**
     *  Set the subject text string upon which the break iterator is operating
     *  without changing any other aspect of the matching state.
     *  The new and previous text strings must have the same content.
     *
     *  This function is intended for use in environments where ICU is operating on
     *  strings that may move around in memory.  It provides a mechanism for notifying
     *  ICU that the string has been relocated, and providing a new UText to access the
     *  string in its new position.
     *
     *  Note that the break iterator implementation never copies the underlying text
     *  of a string being processed, but always operates directly on the original text
     *  provided by the user. Refreshing simply drops the references to the old text
     *  and replaces them with references to the new.
     *
     *  Caution:  this function is normally used only by very specialized,
     *  system-level code.  One example use case is with garbage collection that moves
     *  the text in memory.
     *
     * @param input      The new (moved) text string.
     * @param status     Receives errors detected by this function.
     * @return           *this
     *
     * @stable ICU 49
     */
    virtual RuleBasedBreakIterator &refreshInputText(UText *input, UErrorCode &status) override;


private:
    //=======================================================================
    // implementation
    //=======================================================================
    /**
     * Iterate backwards from an arbitrary position in the input text using the
     * synthesized Safe Reverse rules.
     * This locates a "Safe Position" from which the forward break rules
     * will operate correctly. A Safe Position is not necessarily a boundary itself.
     *
     * @param fromPosition the position in the input text to begin the iteration.
     */
    int32_t handleSafePrevious(int32_t fromPosition);

    /**
     * Find a rule-based boundary by running the state machine.
     * Input
     *    fPosition, the position in the text to begin from.
     * Output
     *    fPosition:           the boundary following the starting position.
     *    fDictionaryCharCount the number of dictionary characters encountered.
     *                         If > 0, the segment will be further subdivided
     *    fRuleStatusIndex     Info from the state table indicating which rules caused the boundary.
     */
    int32_t handleNext();

    /*
     * Templatized version of handleNext() and handleSafePrevious().
     *
     * There will be exactly four instantiations, two each for 8 and 16 bit tables,
     * two each for 8 and 16 bit trie.
     * Having separate instantiations for the table types keeps conditional tests of
     * the table type out of the inner loops, at the expense of replicated code.
     *
     * The template parameter for the Trie access function is a value, not a type.
     * Doing it this way, the compiler will inline the Trie function in the
     * expanded functions. (Both the 8 and 16 bit access functions have the same type
     * signature)
     */

    typedef uint16_t (*PTrieFunc)(const UCPTrie *, UChar32);

    template<typename RowType, PTrieFunc trieFunc>
    int32_t handleSafePrevious(int32_t fromPosition);

    template<typename RowType, PTrieFunc trieFunc>
    int32_t handleNext();


    /**
     * This function returns the appropriate LanguageBreakEngine for a
     * given character c.
     * @param c         A character in the dictionary set
     * @param locale    The locale.
     */
    const LanguageBreakEngine *getLanguageBreakEngine(UChar32 c, const char* locale);

  public:
#ifndef U_HIDE_INTERNAL_API
    /**
     *   Debugging function only.
     *   @internal
     */
     void dumpCache();

    /**
     * Debugging function only.
     * @internal
     */
    void dumpTables();
#endif  /* U_HIDE_INTERNAL_API */

#ifndef U_HIDE_INTERNAL_API
    /**
     * Register a new external break engine. The external break engine will be adopted.
     * Because ICU may choose to cache break engine internally, this must
     * be called at application startup, prior to any calls to
     * object methods of RuleBasedBreakIterator to avoid undefined behavior.
     * @param toAdopt the ExternalBreakEngine instance to be adopted
     * @param status the in/out status code, no special meanings are assigned
     * @internal ICU 74 technology preview
     */
    static void U_EXPORT2 registerExternalBreakEngine(
                  ExternalBreakEngine* toAdopt, UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

};


U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_BREAK_ITERATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
