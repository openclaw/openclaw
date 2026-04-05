// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*   Copyright (C) 2010-2012,2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
*******************************************************************************
*   file name:  stringtriebuilder.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2010dec24
*   created by: Markus W. Scherer
*/

#ifndef __STRINGTRIEBUILDER_H__
#define __STRINGTRIEBUILDER_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/uobject.h"

/**
 * \file
 * \brief C++ API: Builder API for trie builders
 */

// Forward declaration.
/// \cond
struct UHashtable;
typedef struct UHashtable UHashtable;
/// \endcond

/**
 * Build options for BytesTrieBuilder and CharsTrieBuilder.
 * @stable ICU 4.8
 */
enum UStringTrieBuildOption {
    /**
     * Builds a trie quickly.
     * @stable ICU 4.8
     */
    USTRINGTRIE_BUILD_FAST,
    /**
     * Builds a trie more slowly, attempting to generate
     * a shorter but equivalent serialization.
     * This build option also uses more memory.
     *
     * This option can be effective when many integer values are the same
     * and string/byte sequence suffixes can be shared.
     * Runtime speed is not expected to improve.
     * @stable ICU 4.8
     */
    USTRINGTRIE_BUILD_SMALL
};

U_NAMESPACE_BEGIN

/**
 * Base class for string trie builder classes.
 *
 * This class is not intended for public subclassing.
 * @stable ICU 4.8
 */
class U_COMMON_API StringTrieBuilder : public UObject {
public:
#ifndef U_HIDE_INTERNAL_API
    /** @internal */
    static int32_t hashNode(const void *node);
    /** @internal */
    static UBool equalNodes(const void *left, const void *right);
#endif  /* U_HIDE_INTERNAL_API */

protected:
    // Do not enclose the protected default constructor with #ifndef U_HIDE_INTERNAL_API
    // or else the compiler will create a public default constructor.
    /** @internal */
    StringTrieBuilder();
    /** @internal */
    virtual ~StringTrieBuilder();

#ifndef U_HIDE_INTERNAL_API
    /** @internal */
    void createCompactBuilder(int32_t sizeGuess, UErrorCode &errorCode);
    /** @internal */
    void deleteCompactBuilder();

    /** @internal */
    void build(UStringTrieBuildOption buildOption, int32_t elementsLength, UErrorCode &errorCode);

    /** @internal */
    int32_t writeNode(int32_t start, int32_t limit, int32_t unitIndex);
    /** @internal */
    int32_t writeBranchSubNode(int32_t start, int32_t limit, int32_t unitIndex, int32_t length);
#endif  /* U_HIDE_INTERNAL_API */

    class Node;

#ifndef U_HIDE_INTERNAL_API
    /** @internal */
    Node *makeNode(int32_t start, int32_t limit, int32_t unitIndex, UErrorCode &errorCode);
    /** @internal */
    Node *makeBranchSubNode(int32_t start, int32_t limit, int32_t unitIndex,
                            int32_t length, UErrorCode &errorCode);
#endif  /* U_HIDE_INTERNAL_API */

    /** @internal */
    virtual int32_t getElementStringLength(int32_t i) const = 0;
    /** @internal */
    virtual char16_t getElementUnit(int32_t i, int32_t unitIndex) const = 0;
    /** @internal */
    virtual int32_t getElementValue(int32_t i) const = 0;

    // Finds the first unit index after this one where
    // the first and last element have different units again.
    /** @internal */
    virtual int32_t getLimitOfLinearMatch(int32_t first, int32_t last, int32_t unitIndex) const = 0;

    // Number of different units at unitIndex.
    /** @internal */
    virtual int32_t countElementUnits(int32_t start, int32_t limit, int32_t unitIndex) const = 0;
    /** @internal */
    virtual int32_t skipElementsBySomeUnits(int32_t i, int32_t unitIndex, int32_t count) const = 0;
    /** @internal */
    virtual int32_t indexOfElementWithNextUnit(int32_t i, int32_t unitIndex, char16_t unit) const = 0;

    /** @internal */
    virtual UBool matchNodesCanHaveValues() const = 0;

    /** @internal */
    virtual int32_t getMaxBranchLinearSubNodeLength() const = 0;
    /** @internal */
    virtual int32_t getMinLinearMatch() const = 0;
    /** @internal */
    virtual int32_t getMaxLinearMatchLength() const = 0;

#ifndef U_HIDE_INTERNAL_API
    // max(BytesTrie::kMaxBranchLinearSubNodeLength, UCharsTrie::kMaxBranchLinearSubNodeLength).
    /** @internal */
    static const int32_t kMaxBranchLinearSubNodeLength=5;

    // Maximum number of nested split-branch levels for a branch on all 2^16 possible char16_t units.
    // log2(2^16/kMaxBranchLinearSubNodeLength) rounded up.
    /** @internal */
    static const int32_t kMaxSplitBranchLevels=14;

    /**
     * Makes sure that there is only one unique node registered that is
     * equivalent to newNode.
     * @param newNode Input node. The builder takes ownership.
     * @param errorCode ICU in/out UErrorCode.
                        Set to U_MEMORY_ALLOCATION_ERROR if it was success but newNode==nullptr.
     * @return newNode if it is the first of its kind, or
     *         an equivalent node if newNode is a duplicate.
     * @internal
     */
    Node *registerNode(Node *newNode, UErrorCode &errorCode);
    /**
     * Makes sure that there is only one unique FinalValueNode registered
     * with this value.
     * Avoids creating a node if the value is a duplicate.
     * @param value A final value.
     * @param errorCode ICU in/out UErrorCode.
                        Set to U_MEMORY_ALLOCATION_ERROR if it was success but newNode==nullptr.
     * @return A FinalValueNode with the given value.
     * @internal
     */
    Node *registerFinalValue(int32_t value, UErrorCode &errorCode);
#endif  /* U_HIDE_INTERNAL_API */

    /*
     * C++ note:
     * registerNode() and registerFinalValue() take ownership of their input nodes,
     * and only return owned nodes.
     * If they see a failure UErrorCode, they will delete the input node.
     * If they get a nullptr pointer, they will record a U_MEMORY_ALLOCATION_ERROR.
     * If there is a failure, they return nullptr.
     *
     * nullptr Node pointers can be safely passed into other Nodes because
     * they call the static Node::hashCode() which checks for a nullptr pointer first.
     *
     * Therefore, as long as builder functions register a new node,
     * they need to check for failures only before explicitly dereferencing
     * a Node pointer, or before setting a new UErrorCode.
     */

    // Hash set of nodes, maps from nodes to integer 1.
    /** @internal */
    UHashtable *nodes;

    // Do not conditionalize the following with #ifndef U_HIDE_INTERNAL_API,
    // it is needed for layout of other objects.
    /**
     * @internal
     * \cond
     */
    class Node : public UObject {
    public:
        Node(int32_t initialHash) : hash(initialHash), offset(0) {}
        inline int32_t hashCode() const { return hash; }
        // Handles node==nullptr.
        static inline int32_t hashCode(const Node *node) { return node==nullptr ? 0 : node->hashCode(); }
        // Base class operator==() compares the actual class types.
        virtual bool operator==(const Node &other) const;
        inline bool operator!=(const Node &other) const { return !operator==(other); }
        /**
         * Traverses the Node graph and numbers branch edges, with rightmost edges first.
         * This is to avoid writing a duplicate node twice.
         *
         * Branch nodes in this trie data structure are not symmetric.
         * Most branch edges "jump" to other nodes but the rightmost branch edges
         * just continue without a jump.
         * Therefore, write() must write the rightmost branch edge last
         * (trie units are written backwards), and must write it at that point even if
         * it is a duplicate of a node previously written elsewhere.
         *
         * This function visits and marks right branch edges first.
         * Edges are numbered with increasingly negative values because we share the
         * offset field which gets positive values when nodes are written.
         * A branch edge also remembers the first number for any of its edges.
         *
         * When a further-left branch edge has a number in the range of the rightmost
         * edge's numbers, then it will be written as part of the required right edge
         * and we can avoid writing it first.
         *
         * After root.markRightEdgesFirst(-1) the offsets of all nodes are negative
         * edge numbers.
         *
         * @param edgeNumber The first edge number for this node and its sub-nodes.
         * @return An edge number that is at least the maximum-negative
         *         of the input edge number and the numbers of this node and all of its sub-nodes.
         */
        virtual int32_t markRightEdgesFirst(int32_t edgeNumber);
        // write() must set the offset to a positive value.
        virtual void write(StringTrieBuilder &builder) = 0;
        // See markRightEdgesFirst.
        inline void writeUnlessInsideRightEdge(int32_t firstRight, int32_t lastRight,
                                               StringTrieBuilder &builder) {
            // Note: Edge numbers are negative, lastRight<=firstRight.
            // If offset>0 then this node and its sub-nodes have been written already
            // and we need not write them again.
            // If this node is part of the unwritten right branch edge,
            // then we wait until that is written.
            if(offset<0 && (offset<lastRight || firstRight<offset)) {
                write(builder);
            }
        }
        inline int32_t getOffset() const { return offset; }
    protected:
        int32_t hash;
        int32_t offset;
    };

#ifndef U_HIDE_INTERNAL_API
    // This class should not be overridden because
    // registerFinalValue() compares a stack-allocated FinalValueNode
    // (stack-allocated so that we don't unnecessarily create lots of duplicate nodes)
    // with the input node, and the
    // !Node::operator==(other) used inside FinalValueNode::operator==(other)
    // will be false if the typeid's are different.
    /** @internal */
    class FinalValueNode : public Node {
    public:
        FinalValueNode(int32_t v) : Node(0x111111u*37u+v), value(v) {}
        virtual bool operator==(const Node &other) const override;
        virtual void write(StringTrieBuilder &builder) override;
    protected:
        int32_t value;
    };
#endif  /* U_HIDE_INTERNAL_API */

    // Do not conditionalize the following with #ifndef U_HIDE_INTERNAL_API,
    // it is needed for layout of other objects.
    /**
     * @internal 
     */
    class ValueNode : public Node {
    public:
        ValueNode(int32_t initialHash) : Node(initialHash), hasValue(false), value(0) {}
        virtual bool operator==(const Node &other) const override;
        void setValue(int32_t v) {
            hasValue=true;
            value=v;
            hash=hash*37u+v;
        }
    protected:
        UBool hasValue;
        int32_t value;
    };

#ifndef U_HIDE_INTERNAL_API
    /** 
     * @internal 
     */
    class IntermediateValueNode : public ValueNode {
    public:
        IntermediateValueNode(int32_t v, Node *nextNode)
                : ValueNode(0x222222u*37u+hashCode(nextNode)), next(nextNode) { setValue(v); }
        virtual bool operator==(const Node &other) const override;
        virtual int32_t markRightEdgesFirst(int32_t edgeNumber) override;
        virtual void write(StringTrieBuilder &builder) override;
    protected:
        Node *next;
    };
#endif  /* U_HIDE_INTERNAL_API */

    // Do not conditionalize the following with #ifndef U_HIDE_INTERNAL_API,
    // it is needed for layout of other objects.
    /**
     * @internal 
     */
    class LinearMatchNode : public ValueNode {
    public:
        LinearMatchNode(int32_t len, Node *nextNode)
                : ValueNode((0x333333u*37u+len)*37u+hashCode(nextNode)),
                  length(len), next(nextNode) {}
        virtual bool operator==(const Node &other) const override;
        virtual int32_t markRightEdgesFirst(int32_t edgeNumber) override;
    protected:
        int32_t length;
        Node *next;
    };

#ifndef U_HIDE_INTERNAL_API
    /**
     * @internal 
     */
    class BranchNode : public Node {
    public:
        BranchNode(int32_t initialHash) : Node(initialHash) {}
    protected:
        int32_t firstEdgeNumber;
    };

    /**
     * @internal 
     */
    class ListBranchNode : public BranchNode {
    public:
        ListBranchNode() : BranchNode(0x444444), length(0) {}
        virtual bool operator==(const Node &other) const override;
        virtual int32_t markRightEdgesFirst(int32_t edgeNumber) override;
        virtual void write(StringTrieBuilder &builder) override;
        // Adds a unit with a final value.
        void add(int32_t c, int32_t value) {
            units[length] = static_cast<char16_t>(c);
            equal[length]=nullptr;
            values[length]=value;
            ++length;
            hash=(hash*37u+c)*37u+value;
        }
        // Adds a unit which leads to another match node.
        void add(int32_t c, Node *node) {
            units[length] = static_cast<char16_t>(c);
            equal[length]=node;
            values[length]=0;
            ++length;
            hash=(hash*37u+c)*37u+hashCode(node);
        }
    protected:
        Node *equal[kMaxBranchLinearSubNodeLength];  // nullptr means "has final value".
        int32_t length;
        int32_t values[kMaxBranchLinearSubNodeLength];
        char16_t units[kMaxBranchLinearSubNodeLength];
    };

    /**
     * @internal 
     */
    class SplitBranchNode : public BranchNode {
    public:
        SplitBranchNode(char16_t middleUnit, Node *lessThanNode, Node *greaterOrEqualNode)
                : BranchNode(((0x555555u*37u+middleUnit)*37u+
                              hashCode(lessThanNode))*37u+hashCode(greaterOrEqualNode)),
                  unit(middleUnit), lessThan(lessThanNode), greaterOrEqual(greaterOrEqualNode) {}
        virtual bool operator==(const Node &other) const override;
        virtual int32_t markRightEdgesFirst(int32_t edgeNumber) override;
        virtual void write(StringTrieBuilder &builder) override;
    protected:
        char16_t unit;
        Node *lessThan;
        Node *greaterOrEqual;
    };

    // Branch head node, for writing the actual node lead unit.
    /** @internal */
    class BranchHeadNode : public ValueNode {
    public:
        BranchHeadNode(int32_t len, Node *subNode)
                : ValueNode((0x666666u*37u+len)*37u+hashCode(subNode)),
                  length(len), next(subNode) {}
        virtual bool operator==(const Node &other) const override;
        virtual int32_t markRightEdgesFirst(int32_t edgeNumber) override;
        virtual void write(StringTrieBuilder &builder) override;
    protected:
        int32_t length;
        Node *next;  // A branch sub-node.
    };

#endif  /* U_HIDE_INTERNAL_API */
    /// \endcond

    /** @internal */
    virtual Node *createLinearMatchNode(int32_t i, int32_t unitIndex, int32_t length,
                                        Node *nextNode) const = 0;

    /** @internal */
    virtual int32_t write(int32_t unit) = 0;
    /** @internal */
    virtual int32_t writeElementUnits(int32_t i, int32_t unitIndex, int32_t length) = 0;
    /** @internal */
    virtual int32_t writeValueAndFinal(int32_t i, UBool isFinal) = 0;
    /** @internal */
    virtual int32_t writeValueAndType(UBool hasValue, int32_t value, int32_t node) = 0;
    /** @internal */
    virtual int32_t writeDeltaTo(int32_t jumpTarget) = 0;
};

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif  // __STRINGTRIEBUILDER_H__
