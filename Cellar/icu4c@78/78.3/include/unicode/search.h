// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 2001-2011 IBM and others. All rights reserved.
**********************************************************************
*   Date        Name        Description
*  03/22/2000   helena      Creation.
**********************************************************************
*/

#ifndef SEARCH_H
#define SEARCH_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: SearchIterator object.
 */
 
#if !UCONFIG_NO_COLLATION && !UCONFIG_NO_BREAK_ITERATION

#include "unicode/uobject.h"
#include "unicode/unistr.h"
#include "unicode/chariter.h"
#include "unicode/brkiter.h"
#include "unicode/usearch.h"

/**
* @stable ICU 2.0
*/
struct USearch;
/**
* @stable ICU 2.0
*/
typedef struct USearch USearch;

U_NAMESPACE_BEGIN

/**
 *
 * <tt>SearchIterator</tt> is an abstract base class that provides 
 * methods to search for a pattern within a text string. Instances of
 * <tt>SearchIterator</tt> maintain a current position and scans over the 
 * target text, returning the indices the pattern is matched and the length 
 * of each match.
 * <p>
 * <tt>SearchIterator</tt> defines a protocol for text searching. 
 * Subclasses provide concrete implementations of various search algorithms. 
 * For example, <tt>StringSearch</tt> implements language-sensitive pattern 
 * matching based on the comparison rules defined in a 
 * <tt>RuleBasedCollator</tt> object. 
 * <p> 
 * Other options for searching includes using a BreakIterator to restrict 
 * the points at which matches are detected.
 * <p>
 * <tt>SearchIterator</tt> provides an API that is similar to that of
 * other text iteration classes such as <tt>BreakIterator</tt>. Using 
 * this class, it is easy to scan through text looking for all occurrences of 
 * a given pattern. The following example uses a <tt>StringSearch</tt> 
 * object to find all instances of "fox" in the target string. Any other 
 * subclass of <tt>SearchIterator</tt> can be used in an identical 
 * manner.
 * <pre><code>
 * UnicodeString target("The quick brown fox jumped over the lazy fox");
 * UnicodeString pattern("fox");
 *
 * SearchIterator *iter  = new StringSearch(pattern, target);
 * UErrorCode      error = U_ZERO_ERROR;
 * for (int pos = iter->first(error); pos != USEARCH_DONE; 
 *                               pos = iter->next(error)) {
 *     printf("Found match at %d pos, length is %d\n", pos, iter.getMatchedLength());
 * }
 * </code></pre>
 *
 * @see StringSearch
 * @see RuleBasedCollator
 */
class U_I18N_API SearchIterator : public UObject {

public:

    // public constructors and destructors -------------------------------

    /** 
    * Copy constructor that creates a SearchIterator instance with the same 
    * behavior, and iterating over the same text. 
    * @param other the SearchIterator instance to be copied.
    * @stable ICU 2.0
    */
    SearchIterator(const SearchIterator &other);

    /**
     * Destructor. Cleans up the search iterator data struct.
     * @stable ICU 2.0
     */
    virtual ~SearchIterator();

    // public get and set methods ----------------------------------------

    /**
     * Sets the index to point to the given position, and clears any state 
     * that's affected.
     * <p>
     * This method takes the argument index and sets the position in the text 
     * string accordingly without checking if the index is pointing to a 
     * valid starting point to begin searching. 
     * @param position within the text to be set. If position is less
     *             than or greater than the text range for searching, 
     *          an U_INDEX_OUTOFBOUNDS_ERROR will be returned
     * @param status for errors if it occurs
     * @stable ICU 2.0
     */
    virtual void setOffset(int32_t position, UErrorCode &status) = 0;

    /**
     * Return the current index in the text being searched.
     * If the iteration has gone past the end of the text
     * (or past the beginning for a backwards search), USEARCH_DONE
     * is returned.
     * @return current index in the text being searched.
     * @stable ICU 2.0
     */
    virtual int32_t getOffset() const = 0;

    /**
    * Sets the text searching attributes located in the enum 
    * USearchAttribute with values from the enum USearchAttributeValue.
    * USEARCH_DEFAULT can be used for all attributes for resetting.
    * @param attribute text attribute (enum USearchAttribute) to be set
    * @param value text attribute value
    * @param status for errors if it occurs
    * @stable ICU 2.0
    */
    void setAttribute(USearchAttribute       attribute,
                      USearchAttributeValue  value,
                      UErrorCode            &status);

    /**    
    * Gets the text searching attributes
    * @param attribute text attribute (enum USearchAttribute) to be retrieve
    * @return text attribute value
    * @stable ICU 2.0
    */
    USearchAttributeValue getAttribute(USearchAttribute  attribute) const;
    
    /**
    * Returns the index to the match in the text string that was searched.
    * This call returns a valid result only after a successful call to 
    * <tt>first</tt>, <tt>next</tt>, <tt>previous</tt>, or <tt>last</tt>.
    * Just after construction, or after a searching method returns 
    * <tt>USEARCH_DONE</tt>, this method will return <tt>USEARCH_DONE</tt>.
    * <p>
    * Use getMatchedLength to get the matched string length.
    * @return index of a substring within the text string that is being 
    *         searched.
    * @see #first
    * @see #next
    * @see #previous
    * @see #last
    * @stable ICU 2.0
    */
    int32_t getMatchedStart() const;

    /**
     * Returns the length of text in the string which matches the search 
     * pattern. This call returns a valid result only after a successful call 
     * to <tt>first</tt>, <tt>next</tt>, <tt>previous</tt>, or <tt>last</tt>.
     * Just after construction, or after a searching method returns 
     * <tt>USEARCH_DONE</tt>, this method will return 0.
     * @return The length of the match in the target text, or 0 if there
     *         is no match currently.
     * @see #first
     * @see #next
     * @see #previous
     * @see #last
     * @stable ICU 2.0
     */
    int32_t getMatchedLength() const;

    /**
     * Returns the text that was matched by the most recent call to 
     * <tt>first</tt>, <tt>next</tt>, <tt>previous</tt>, or <tt>last</tt>.
     * If the iterator is not pointing at a valid match (e.g. just after 
     * construction or after <tt>USEARCH_DONE</tt> has been returned, 
     * returns an empty string. 
     * @param result stores the matched string or an empty string if a match
     *        is not found.
     * @see #first
     * @see #next
     * @see #previous
     * @see #last
     * @stable ICU 2.0
     */
    void getMatchedText(UnicodeString &result) const;
    
    /**
     * Set the BreakIterator that will be used to restrict the points
     * at which matches are detected. The user is responsible for deleting 
     * the breakiterator.
     * @param breakiter A BreakIterator that will be used to restrict the 
     *                points at which matches are detected. If a match is 
     *                found, but the match's start or end index is not a 
     *                boundary as determined by the <tt>BreakIterator</tt>, 
     *                the match will be rejected and another will be searched 
     *                for. If this parameter is <tt>nullptr</tt>, no break
     *                detection is attempted.
     * @param status for errors if it occurs
     * @see BreakIterator
     * @stable ICU 2.0
     */
    void setBreakIterator(BreakIterator *breakiter, UErrorCode &status);
    
    /**
     * Returns the BreakIterator that is used to restrict the points at 
     * which matches are detected.  This will be the same object that was 
     * passed to the constructor or to <tt>setBreakIterator</tt>.
     * Note that <tt>nullptr</tt> is a legal value; it means that break
     * detection should not be attempted.
     * @return BreakIterator used to restrict matchings.
     * @see #setBreakIterator
     * @stable ICU 2.0
     */
    const BreakIterator* getBreakIterator() const;

    /**
     * Set the string text to be searched. Text iteration will hence begin at 
     * the start of the text string. This method is useful if you want to 
     * re-use an iterator to search for the same pattern within a different 
     * body of text. The user is responsible for deleting the text.
     * @param text string to be searched.
     * @param status for errors. If the text length is 0, 
     *        an U_ILLEGAL_ARGUMENT_ERROR is returned.
     * @stable ICU 2.0
     */
    virtual void setText(const UnicodeString &text, UErrorCode &status);    

    /**
     * Set the string text to be searched. Text iteration will hence begin at 
     * the start of the text string. This method is useful if you want to 
     * re-use an iterator to search for the same pattern within a different 
     * body of text.
     * <p>
     * Note: No parsing of the text within the <tt>CharacterIterator</tt> 
     * will be done during searching for this version. The block of text 
     * in <tt>CharacterIterator</tt> will be used as it is.
     * The user is responsible for deleting the text.
     * @param text string iterator to be searched.
     * @param status for errors if any. If the text length is 0 then an 
     *        U_ILLEGAL_ARGUMENT_ERROR is returned.
     * @stable ICU 2.0
     */
    virtual void setText(CharacterIterator &text, UErrorCode &status);
    
    /**
     * Return the string text to be searched.
     * @return text string to be searched.
     * @stable ICU 2.0
     */
    const UnicodeString& getText() const;

    // operator overloading ----------------------------------------------

    /**
     * Equality operator. 
     * @param that SearchIterator instance to be compared.
     * @return true if both BreakIterators are of the same class, have the 
     *         same behavior, terates over the same text and have the same
     *         attributes. false otherwise.
     * @stable ICU 2.0
     */
    virtual bool operator==(const SearchIterator &that) const;

    /**
     * Not-equal operator. 
     * @param that SearchIterator instance to be compared.
     * @return false if operator== returns true, and vice versa.
     * @stable ICU 2.0
     */
    bool operator!=(const SearchIterator &that) const;

    // public methods ----------------------------------------------------

    /**
     * Returns a copy of SearchIterator with the same behavior, and 
     * iterating over the same text, as this one. Note that all data will be
     * replicated, except for the text string to be searched.
     * @return cloned object
     * @stable ICU 2.0
     */
    virtual SearchIterator* safeClone() const = 0;

    /**
     * Returns the first index at which the string text matches the search 
     * pattern. The iterator is adjusted so that its current index (as 
     * returned by <tt>getOffset</tt>) is the match position if one 
     * was found.
     * If a match is not found, <tt>USEARCH_DONE</tt> will be returned and
     * the iterator will be adjusted to the index USEARCH_DONE
     * @param  status for errors if it occurs
     * @return The character index of the first match, or 
     *         <tt>USEARCH_DONE</tt> if there are no matches.
     * @see #getOffset
     * @stable ICU 2.0
     */
    int32_t first(UErrorCode &status);

    /**
     * Returns the first index equal or greater than <tt>position</tt> at which the 
     * string text matches the search pattern. The iterator is adjusted so 
     * that its current index (as returned by <tt>getOffset</tt>) is the 
     * match position if one was found.
     * If a match is not found, <tt>USEARCH_DONE</tt> will be returned and the
     * iterator will be adjusted to the index <tt>USEARCH_DONE</tt>.
     * @param  position where search if to start from. If position is less
     *             than or greater than the text range for searching, 
     *          an U_INDEX_OUTOFBOUNDS_ERROR will be returned
     * @param  status for errors if it occurs
     * @return The character index of the first match following 
     *         <tt>position</tt>, or <tt>USEARCH_DONE</tt> if there are no 
     *         matches.
     * @see #getOffset
     * @stable ICU 2.0
     */
    int32_t following(int32_t position, UErrorCode &status);
    
    /**
     * Returns the last index in the target text at which it matches the 
     * search pattern. The iterator is adjusted so that its current index 
     * (as returned by <tt>getOffset</tt>) is the match position if one was 
     * found.
     * If a match is not found, <tt>USEARCH_DONE</tt> will be returned and
     * the iterator will be adjusted to the index USEARCH_DONE.
     * @param  status for errors if it occurs
     * @return The index of the first match, or <tt>USEARCH_DONE</tt> if 
     *         there are no matches.
     * @see #getOffset
     * @stable ICU 2.0
     */
    int32_t last(UErrorCode &status);

    /**
     * Returns the first index less than <tt>position</tt> at which the string 
     * text matches the search pattern. The iterator is adjusted so that its 
     * current index (as returned by <tt>getOffset</tt>) is the match 
     * position if one was found. If a match is not found, 
     * <tt>USEARCH_DONE</tt> will be returned and the iterator will be 
     * adjusted to the index USEARCH_DONE
     * <p>
     * When <tt>USEARCH_OVERLAP</tt> option is off, the last index of the
     * result match is always less than <tt>position</tt>.
     * When <tt>USERARCH_OVERLAP</tt> is on, the result match may span across
     * <tt>position</tt>.
     *
     * @param  position where search is to start from. If position is less
     *             than or greater than the text range for searching, 
     *          an U_INDEX_OUTOFBOUNDS_ERROR will be returned
     * @param  status for errors if it occurs
     * @return The character index of the first match preceding 
     *         <tt>position</tt>, or <tt>USEARCH_DONE</tt> if there are 
     *         no matches.
     * @see #getOffset
     * @stable ICU 2.0
     */
    int32_t preceding(int32_t position, UErrorCode &status);

    /**
     * Returns the index of the next point at which the text matches the
     * search pattern, starting from the current position
     * The iterator is adjusted so that its current index (as returned by 
     * <tt>getOffset</tt>) is the match position if one was found.
     * If a match is not found, <tt>USEARCH_DONE</tt> will be returned and
     * the iterator will be adjusted to a position after the end of the text 
     * string.
     * @param  status for errors if it occurs
     * @return The index of the next match after the current position,
     *          or <tt>USEARCH_DONE</tt> if there are no more matches.
     * @see #getOffset
     * @stable ICU 2.0
     */
     int32_t next(UErrorCode &status);

    /**
     * Returns the index of the previous point at which the string text 
     * matches the search pattern, starting at the current position.
     * The iterator is adjusted so that its current index (as returned by 
     * <tt>getOffset</tt>) is the match position if one was found.
     * If a match is not found, <tt>USEARCH_DONE</tt> will be returned and
     * the iterator will be adjusted to the index USEARCH_DONE
     * @param  status for errors if it occurs
     * @return The index of the previous match before the current position,
     *          or <tt>USEARCH_DONE</tt> if there are no more matches.
     * @see #getOffset
     * @stable ICU 2.0
     */
    int32_t previous(UErrorCode &status);

    /** 
    * Resets the iteration.
    * Search will begin at the start of the text string if a forward 
    * iteration is initiated before a backwards iteration. Otherwise if a 
    * backwards iteration is initiated before a forwards iteration, the 
    * search will begin at the end of the text string.    
    * @stable ICU 2.0
    */
    virtual void reset();

protected:
    // protected data members ---------------------------------------------

    /**
    * C search data struct
    * @stable ICU 2.0
    */
    USearch *m_search_;

    /**
    * Break iterator.
    * Currently the C++ breakiterator does not have getRules etc to reproduce
    * another in C. Hence we keep the original around and do the verification
    * at the end of the match. The user is responsible for deleting this
    * break iterator.
    * @stable ICU 2.0
    */
    BreakIterator *m_breakiterator_;
    
    /**
    * Unicode string version of the search text
    * @stable ICU 2.0
    */
    UnicodeString  m_text_;

    // protected constructors and destructors -----------------------------

    /**
    * Default constructor.
    * Initializes data to the default values.
    * @stable ICU 2.0
    */
    SearchIterator();

    /**
     * Constructor for use by subclasses.
     * @param text The target text to be searched.
     * @param breakiter A {@link BreakIterator} that is used to restrict the 
     *                points at which matches are detected. If 
     *                <tt>handleNext</tt> or <tt>handlePrev</tt> finds a 
     *                match, but the match's start or end index is not a 
     *                boundary as determined by the <tt>BreakIterator</tt>, 
     *                the match is rejected and <tt>handleNext</tt> or 
     *                <tt>handlePrev</tt> is called again. If this parameter 
     *                is <tt>nullptr</tt>, no break detection is attempted.
     * @see #handleNext
     * @see #handlePrev
     * @stable ICU 2.0
     */
    SearchIterator(const UnicodeString &text, 
                         BreakIterator *breakiter = nullptr);

    /**
     * Constructor for use by subclasses.
     * <p>
     * Note: No parsing of the text within the <tt>CharacterIterator</tt> 
     * will be done during searching for this version. The block of text 
     * in <tt>CharacterIterator</tt> will be used as it is.
     * @param text The target text to be searched.
     * @param breakiter A {@link BreakIterator} that is used to restrict the 
     *                points at which matches are detected. If 
     *                <tt>handleNext</tt> or <tt>handlePrev</tt> finds a 
     *                match, but the match's start or end index is not a 
     *                boundary as determined by the <tt>BreakIterator</tt>, 
     *                the match is rejected and <tt>handleNext</tt> or 
     *                <tt>handlePrev</tt> is called again. If this parameter 
     *                is <tt>nullptr</tt>, no break detection is attempted.
     * @see #handleNext
     * @see #handlePrev
     * @stable ICU 2.0
     */
    SearchIterator(CharacterIterator &text, BreakIterator *breakiter = nullptr);

    // protected methods --------------------------------------------------

    /**
     * Assignment operator. Sets this iterator to have the same behavior,
     * and iterate over the same text, as the one passed in.
     * @param that instance to be copied.
     * @stable ICU 2.0
     */
    SearchIterator & operator=(const SearchIterator &that);

    /**
     * Abstract method which subclasses override to provide the mechanism
     * for finding the next match in the target text. This allows different
     * subclasses to provide different search algorithms.
     * <p>
     * If a match is found, the implementation should return the index at
     * which the match starts and should call 
     * <tt>setMatchLength</tt> with the number of characters 
     * in the target text that make up the match. If no match is found, the 
     * method should return USEARCH_DONE.
     * <p>
     * @param position The index in the target text at which the search 
     *                 should start.
     * @param status for error codes if it occurs.
     * @return index at which the match starts, else if match is not found 
     *         USEARCH_DONE is returned
     * @see #setMatchLength
     * @stable ICU 2.0
     */
    virtual int32_t handleNext(int32_t position, UErrorCode &status) 
                                                                         = 0;

    /**
     * Abstract method which subclasses override to provide the mechanism for
     * finding the previous match in the target text. This allows different
     * subclasses to provide different search algorithms.
     * <p>
     * If a match is found, the implementation should return the index at
     * which the match starts and should call 
     * <tt>setMatchLength</tt> with the number of characters 
     * in the target text that make up the match. If no match is found, the 
     * method should return USEARCH_DONE.
     * <p>
     * @param position The index in the target text at which the search 
     *                 should start.
     * @param status for error codes if it occurs.
     * @return index at which the match starts, else if match is not found 
     *         USEARCH_DONE is returned
     * @see #setMatchLength
     * @stable ICU 2.0
     */
     virtual int32_t handlePrev(int32_t position, UErrorCode &status) 
                                                                         = 0;

    /**
     * Sets the length of the currently matched string in the text string to
     * be searched.
     * Subclasses' <tt>handleNext</tt> and <tt>handlePrev</tt>
     * methods should call this when they find a match in the target text.
     * @param length length of the matched text.
     * @see #handleNext
     * @see #handlePrev
     * @stable ICU 2.0
     */
    virtual void setMatchLength(int32_t length);

    /**
     * Sets the offset of the currently matched string in the text string to
     * be searched.
     * Subclasses' <tt>handleNext</tt> and <tt>handlePrev</tt>
     * methods should call this when they find a match in the target text.
     * @param position start offset of the matched text.
     * @see #handleNext
     * @see #handlePrev
     * @stable ICU 2.0
     */
    virtual void setMatchStart(int32_t position);

    /**
    * sets match not found 
    * @stable ICU 2.0
    */
    void setMatchNotFound();
};

inline bool SearchIterator::operator!=(const SearchIterator &that) const
{
   return !operator==(that); 
}
U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_COLLATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif

