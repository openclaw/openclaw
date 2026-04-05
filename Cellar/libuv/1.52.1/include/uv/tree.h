/*-
 * Copyright 2002 Niels Provos <provos@citi.umich.edu>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 * IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
 * INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 * NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#ifndef  UV_TREE_H_
#define  UV_TREE_H_

#ifndef UV__UNUSED
# if __GNUC__
#  define UV__UNUSED __attribute__((unused))
# else
#  define UV__UNUSED
# endif
#endif

/*
 * This file defines data structures for red-black trees.
 * A red-black tree is a binary search tree with the node color as an
 * extra attribute.  It fulfills a set of conditions:
 *  - every search path from the root to a leaf consists of the
 *    same number of black nodes,
 *  - each red node (except for the root) has a black parent,
 *  - each leaf node is black.
 *
 * Every operation on a red-black tree is bounded as O(lg n).
 * The maximum height of a red-black tree is 2lg (n+1).
 */

/* Macros that define a red-black tree */
#define RB_HEAD(name, type)                                                   \
struct name {                                                                 \
  struct type *rbh_root; /* root of the tree */                               \
}

#define RB_INITIALIZER(root)                                                  \
  { NULL }

#define RB_INIT(root) do {                                                    \
  (root)->rbh_root = NULL;                                                    \
} while (/*CONSTCOND*/ 0)

#define RB_BLACK  0
#define RB_RED    1
#define RB_ENTRY(type)                                                        \
struct {                                                                      \
  struct type *rbe_left;        /* left element */                            \
  struct type *rbe_right;       /* right element */                           \
  struct type *rbe_parent;      /* parent element */                          \
  int rbe_color;                /* node color */                              \
}

#define RB_LEFT(elm, field)     (elm)->field.rbe_left
#define RB_RIGHT(elm, field)    (elm)->field.rbe_right
#define RB_PARENT(elm, field)   (elm)->field.rbe_parent
#define RB_COLOR(elm, field)    (elm)->field.rbe_color
#define RB_ROOT(head)           (head)->rbh_root
#define RB_EMPTY(head)          (RB_ROOT(head) == NULL)

#define RB_SET(elm, parent, field) do {                                       \
  RB_PARENT(elm, field) = parent;                                             \
  RB_LEFT(elm, field) = RB_RIGHT(elm, field) = NULL;                          \
  RB_COLOR(elm, field) = RB_RED;                                              \
} while (/*CONSTCOND*/ 0)

#define RB_SET_BLACKRED(black, red, field) do {                               \
  RB_COLOR(black, field) = RB_BLACK;                                          \
  RB_COLOR(red, field) = RB_RED;                                              \
} while (/*CONSTCOND*/ 0)

#ifndef RB_AUGMENT
#define RB_AUGMENT(x)  do {} while (0)
#endif

#define RB_ROTATE_LEFT(head, elm, tmp, field) do {                            \
  (tmp) = RB_RIGHT(elm, field);                                               \
  if ((RB_RIGHT(elm, field) = RB_LEFT(tmp, field)) != NULL) {                 \
    RB_PARENT(RB_LEFT(tmp, field), field) = (elm);                            \
  }                                                                           \
  RB_AUGMENT(elm);                                                            \
  if ((RB_PARENT(tmp, field) = RB_PARENT(elm, field)) != NULL) {              \
    if ((elm) == RB_LEFT(RB_PARENT(elm, field), field))                       \
      RB_LEFT(RB_PARENT(elm, field), field) = (tmp);                          \
    else                                                                      \
      RB_RIGHT(RB_PARENT(elm, field), field) = (tmp);                         \
  } else                                                                      \
    (head)->rbh_root = (tmp);                                                 \
  RB_LEFT(tmp, field) = (elm);                                                \
  RB_PARENT(elm, field) = (tmp);                                              \
  RB_AUGMENT(tmp);                                                            \
  if ((RB_PARENT(tmp, field)))                                                \
    RB_AUGMENT(RB_PARENT(tmp, field));                                        \
} while (/*CONSTCOND*/ 0)

#define RB_ROTATE_RIGHT(head, elm, tmp, field) do {                           \
  (tmp) = RB_LEFT(elm, field);                                                \
  if ((RB_LEFT(elm, field) = RB_RIGHT(tmp, field)) != NULL) {                 \
    RB_PARENT(RB_RIGHT(tmp, field), field) = (elm);                           \
  }                                                                           \
  RB_AUGMENT(elm);                                                            \
  if ((RB_PARENT(tmp, field) = RB_PARENT(elm, field)) != NULL) {              \
    if ((elm) == RB_LEFT(RB_PARENT(elm, field), field))                       \
      RB_LEFT(RB_PARENT(elm, field), field) = (tmp);                          \
    else                                                                      \
      RB_RIGHT(RB_PARENT(elm, field), field) = (tmp);                         \
  } else                                                                      \
    (head)->rbh_root = (tmp);                                                 \
  RB_RIGHT(tmp, field) = (elm);                                               \
  RB_PARENT(elm, field) = (tmp);                                              \
  RB_AUGMENT(tmp);                                                            \
  if ((RB_PARENT(tmp, field)))                                                \
    RB_AUGMENT(RB_PARENT(tmp, field));                                        \
} while (/*CONSTCOND*/ 0)

/* Generates prototypes and inline functions */
#define  RB_PROTOTYPE(name, type, field, cmp)                                 \
  RB_PROTOTYPE_INTERNAL(name, type, field, cmp,)
#define  RB_PROTOTYPE_STATIC(name, type, field, cmp)                          \
  RB_PROTOTYPE_INTERNAL(name, type, field, cmp, UV__UNUSED static)
#define RB_PROTOTYPE_INTERNAL(name, type, field, cmp, attr)                   \
attr void name##_RB_INSERT_COLOR(struct name *, struct type *);               \
attr void name##_RB_REMOVE_COLOR(struct name *, struct type *, struct type *);\
attr struct type *name##_RB_REMOVE(struct name *, struct type *);             \
attr struct type *name##_RB_INSERT(struct name *, struct type *);             \
attr struct type *name##_RB_FIND(struct name *, struct type *);               \
attr struct type *name##_RB_NFIND(struct name *, struct type *);              \
attr struct type *name##_RB_NEXT(struct type *);                              \
attr struct type *name##_RB_PREV(struct type *);                              \
attr struct type *name##_RB_MINMAX(struct name *, int);                       \
                                                                              \

/* Main rb operation.
 * Moves node close to the key of elm to top
 */
#define  RB_GENERATE(name, type, field, cmp)                                  \
  RB_GENERATE_INTERNAL(name, type, field, cmp,)
#define  RB_GENERATE_STATIC(name, type, field, cmp)                           \
  RB_GENERATE_INTERNAL(name, type, field, cmp, UV__UNUSED static)
#define RB_GENERATE_INTERNAL(name, type, field, cmp, attr)                    \
attr void                                                                     \
name##_RB_INSERT_COLOR(struct name *head, struct type *elm)                   \
{                                                                             \
  struct type *parent, *gparent, *tmp;                                        \
  while ((parent = RB_PARENT(elm, field)) != NULL &&                          \
      RB_COLOR(parent, field) == RB_RED) {                                    \
    gparent = RB_PARENT(parent, field);                                       \
    if (parent == RB_LEFT(gparent, field)) {                                  \
      tmp = RB_RIGHT(gparent, field);                                         \
      if (tmp && RB_COLOR(tmp, field) == RB_RED) {                            \
        RB_COLOR(tmp, field) = RB_BLACK;                                      \
        RB_SET_BLACKRED(parent, gparent, field);                              \
        elm = gparent;                                                        \
        continue;                                                             \
      }                                                                       \
      if (RB_RIGHT(parent, field) == elm) {                                   \
        RB_ROTATE_LEFT(head, parent, tmp, field);                             \
        tmp = parent;                                                         \
        parent = elm;                                                         \
        elm = tmp;                                                            \
      }                                                                       \
      RB_SET_BLACKRED(parent, gparent, field);                                \
      RB_ROTATE_RIGHT(head, gparent, tmp, field);                             \
    } else {                                                                  \
      tmp = RB_LEFT(gparent, field);                                          \
      if (tmp && RB_COLOR(tmp, field) == RB_RED) {                            \
        RB_COLOR(tmp, field) = RB_BLACK;                                      \
        RB_SET_BLACKRED(parent, gparent, field);                              \
        elm = gparent;                                                        \
        continue;                                                             \
      }                                                                       \
      if (RB_LEFT(parent, field) == elm) {                                    \
        RB_ROTATE_RIGHT(head, parent, tmp, field);                            \
        tmp = parent;                                                         \
        parent = elm;                                                         \
        elm = tmp;                                                            \
      }                                                                       \
      RB_SET_BLACKRED(parent, gparent, field);                                \
      RB_ROTATE_LEFT(head, gparent, tmp, field);                              \
    }                                                                         \
  }                                                                           \
  RB_COLOR(head->rbh_root, field) = RB_BLACK;                                 \
}                                                                             \
                                                                              \
attr void                                                                     \
name##_RB_REMOVE_COLOR(struct name *head, struct type *parent,                \
    struct type *elm)                                                         \
{                                                                             \
  struct type *tmp;                                                           \
  while ((elm == NULL || RB_COLOR(elm, field) == RB_BLACK) &&                 \
      elm != RB_ROOT(head)) {                                                 \
    if (RB_LEFT(parent, field) == elm) {                                      \
      tmp = RB_RIGHT(parent, field);                                          \
      if (RB_COLOR(tmp, field) == RB_RED) {                                   \
        RB_SET_BLACKRED(tmp, parent, field);                                  \
        RB_ROTATE_LEFT(head, parent, tmp, field);                             \
        tmp = RB_RIGHT(parent, field);                                        \
      }                                                                       \
      if ((RB_LEFT(tmp, field) == NULL ||                                     \
          RB_COLOR(RB_LEFT(tmp, field), field) == RB_BLACK) &&                \
          (RB_RIGHT(tmp, field) == NULL ||                                    \
          RB_COLOR(RB_RIGHT(tmp, field), field) == RB_BLACK)) {               \
        RB_COLOR(tmp, field) = RB_RED;                                        \
        elm = parent;                                                         \
        parent = RB_PARENT(elm, field);                                       \
      } else {                                                                \
        if (RB_RIGHT(tmp, field) == NULL ||                                   \
            RB_COLOR(RB_RIGHT(tmp, field), field) == RB_BLACK) {              \
          struct type *oleft;                                                 \
          if ((oleft = RB_LEFT(tmp, field))                                   \
              != NULL)                                                        \
            RB_COLOR(oleft, field) = RB_BLACK;                                \
          RB_COLOR(tmp, field) = RB_RED;                                      \
          RB_ROTATE_RIGHT(head, tmp, oleft, field);                           \
          tmp = RB_RIGHT(parent, field);                                      \
        }                                                                     \
        RB_COLOR(tmp, field) = RB_COLOR(parent, field);                       \
        RB_COLOR(parent, field) = RB_BLACK;                                   \
        if (RB_RIGHT(tmp, field))                                             \
          RB_COLOR(RB_RIGHT(tmp, field), field) = RB_BLACK;                   \
        RB_ROTATE_LEFT(head, parent, tmp, field);                             \
        elm = RB_ROOT(head);                                                  \
        break;                                                                \
      }                                                                       \
    } else {                                                                  \
      tmp = RB_LEFT(parent, field);                                           \
      if (RB_COLOR(tmp, field) == RB_RED) {                                   \
        RB_SET_BLACKRED(tmp, parent, field);                                  \
        RB_ROTATE_RIGHT(head, parent, tmp, field);                            \
        tmp = RB_LEFT(parent, field);                                         \
      }                                                                       \
      if ((RB_LEFT(tmp, field) == NULL ||                                     \
          RB_COLOR(RB_LEFT(tmp, field), field) == RB_BLACK) &&                \
          (RB_RIGHT(tmp, field) == NULL ||                                    \
          RB_COLOR(RB_RIGHT(tmp, field), field) == RB_BLACK)) {               \
        RB_COLOR(tmp, field) = RB_RED;                                        \
        elm = parent;                                                         \
        parent = RB_PARENT(elm, field);                                       \
      } else {                                                                \
        if (RB_LEFT(tmp, field) == NULL ||                                    \
            RB_COLOR(RB_LEFT(tmp, field), field) == RB_BLACK) {               \
          struct type *oright;                                                \
          if ((oright = RB_RIGHT(tmp, field))                                 \
              != NULL)                                                        \
            RB_COLOR(oright, field) = RB_BLACK;                               \
          RB_COLOR(tmp, field) = RB_RED;                                      \
          RB_ROTATE_LEFT(head, tmp, oright, field);                           \
          tmp = RB_LEFT(parent, field);                                       \
        }                                                                     \
        RB_COLOR(tmp, field) = RB_COLOR(parent, field);                       \
        RB_COLOR(parent, field) = RB_BLACK;                                   \
        if (RB_LEFT(tmp, field))                                              \
          RB_COLOR(RB_LEFT(tmp, field), field) = RB_BLACK;                    \
        RB_ROTATE_RIGHT(head, parent, tmp, field);                            \
        elm = RB_ROOT(head);                                                  \
        break;                                                                \
      }                                                                       \
    }                                                                         \
  }                                                                           \
  if (elm)                                                                    \
    RB_COLOR(elm, field) = RB_BLACK;                                          \
}                                                                             \
                                                                              \
attr struct type *                                                            \
name##_RB_REMOVE(struct name *head, struct type *elm)                         \
{                                                                             \
  struct type *child, *parent, *old = elm;                                    \
  int color;                                                                  \
  if (RB_LEFT(elm, field) == NULL)                                            \
    child = RB_RIGHT(elm, field);                                             \
  else if (RB_RIGHT(elm, field) == NULL)                                      \
    child = RB_LEFT(elm, field);                                              \
  else {                                                                      \
    struct type *left;                                                        \
    elm = RB_RIGHT(elm, field);                                               \
    while ((left = RB_LEFT(elm, field)) != NULL)                              \
      elm = left;                                                             \
    child = RB_RIGHT(elm, field);                                             \
    parent = RB_PARENT(elm, field);                                           \
    color = RB_COLOR(elm, field);                                             \
    if (child)                                                                \
      RB_PARENT(child, field) = parent;                                       \
    if (parent) {                                                             \
      if (RB_LEFT(parent, field) == elm)                                      \
        RB_LEFT(parent, field) = child;                                       \
      else                                                                    \
        RB_RIGHT(parent, field) = child;                                      \
      RB_AUGMENT(parent);                                                     \
    } else                                                                    \
      RB_ROOT(head) = child;                                                  \
    if (RB_PARENT(elm, field) == old)                                         \
      parent = elm;                                                           \
    (elm)->field = (old)->field;                                              \
    if (RB_PARENT(old, field)) {                                              \
      if (RB_LEFT(RB_PARENT(old, field), field) == old)                       \
        RB_LEFT(RB_PARENT(old, field), field) = elm;                          \
      else                                                                    \
        RB_RIGHT(RB_PARENT(old, field), field) = elm;                         \
      RB_AUGMENT(RB_PARENT(old, field));                                      \
    } else                                                                    \
      RB_ROOT(head) = elm;                                                    \
    RB_PARENT(RB_LEFT(old, field), field) = elm;                              \
    if (RB_RIGHT(old, field))                                                 \
      RB_PARENT(RB_RIGHT(old, field), field) = elm;                           \
    if (parent) {                                                             \
      left = parent;                                                          \
      do {                                                                    \
        RB_AUGMENT(left);                                                     \
      } while ((left = RB_PARENT(left, field)) != NULL);                      \
    }                                                                         \
    goto color;                                                               \
  }                                                                           \
  parent = RB_PARENT(elm, field);                                             \
  color = RB_COLOR(elm, field);                                               \
  if (child)                                                                  \
    RB_PARENT(child, field) = parent;                                         \
  if (parent) {                                                               \
    if (RB_LEFT(parent, field) == elm)                                        \
      RB_LEFT(parent, field) = child;                                         \
    else                                                                      \
      RB_RIGHT(parent, field) = child;                                        \
    RB_AUGMENT(parent);                                                       \
  } else                                                                      \
    RB_ROOT(head) = child;                                                    \
color:                                                                        \
  if (color == RB_BLACK)                                                      \
    name##_RB_REMOVE_COLOR(head, parent, child);                              \
  return (old);                                                               \
}                                                                             \
                                                                              \
/* Inserts a node into the RB tree */                                         \
attr struct type *                                                            \
name##_RB_INSERT(struct name *head, struct type *elm)                         \
{                                                                             \
  struct type *tmp;                                                           \
  struct type *parent = NULL;                                                 \
  int comp = 0;                                                               \
  tmp = RB_ROOT(head);                                                        \
  while (tmp) {                                                               \
    parent = tmp;                                                             \
    comp = (cmp)(elm, parent);                                                \
    if (comp < 0)                                                             \
      tmp = RB_LEFT(tmp, field);                                              \
    else if (comp > 0)                                                        \
      tmp = RB_RIGHT(tmp, field);                                             \
    else                                                                      \
      return (tmp);                                                           \
  }                                                                           \
  RB_SET(elm, parent, field);                                                 \
  if (parent != NULL) {                                                       \
    if (comp < 0)                                                             \
      RB_LEFT(parent, field) = elm;                                           \
    else                                                                      \
      RB_RIGHT(parent, field) = elm;                                          \
    RB_AUGMENT(parent);                                                       \
  } else                                                                      \
    RB_ROOT(head) = elm;                                                      \
  name##_RB_INSERT_COLOR(head, elm);                                          \
  return (NULL);                                                              \
}                                                                             \
                                                                              \
/* Finds the node with the same key as elm */                                 \
attr struct type *                                                            \
name##_RB_FIND(struct name *head, struct type *elm)                           \
{                                                                             \
  struct type *tmp = RB_ROOT(head);                                           \
  int comp;                                                                   \
  while (tmp) {                                                               \
    comp = cmp(elm, tmp);                                                     \
    if (comp < 0)                                                             \
      tmp = RB_LEFT(tmp, field);                                              \
    else if (comp > 0)                                                        \
      tmp = RB_RIGHT(tmp, field);                                             \
    else                                                                      \
      return (tmp);                                                           \
  }                                                                           \
  return (NULL);                                                              \
}                                                                             \
                                                                              \
/* Finds the first node greater than or equal to the search key */            \
attr struct type *                                                            \
name##_RB_NFIND(struct name *head, struct type *elm)                          \
{                                                                             \
  struct type *tmp = RB_ROOT(head);                                           \
  struct type *res = NULL;                                                    \
  int comp;                                                                   \
  while (tmp) {                                                               \
    comp = cmp(elm, tmp);                                                     \
    if (comp < 0) {                                                           \
      res = tmp;                                                              \
      tmp = RB_LEFT(tmp, field);                                              \
    }                                                                         \
    else if (comp > 0)                                                        \
      tmp = RB_RIGHT(tmp, field);                                             \
    else                                                                      \
      return (tmp);                                                           \
  }                                                                           \
  return (res);                                                               \
}                                                                             \
                                                                              \
/* ARGSUSED */                                                                \
attr struct type *                                                            \
name##_RB_NEXT(struct type *elm)                                              \
{                                                                             \
  if (RB_RIGHT(elm, field)) {                                                 \
    elm = RB_RIGHT(elm, field);                                               \
    while (RB_LEFT(elm, field))                                               \
      elm = RB_LEFT(elm, field);                                              \
  } else {                                                                    \
    if (RB_PARENT(elm, field) &&                                              \
        (elm == RB_LEFT(RB_PARENT(elm, field), field)))                       \
      elm = RB_PARENT(elm, field);                                            \
    else {                                                                    \
      while (RB_PARENT(elm, field) &&                                         \
          (elm == RB_RIGHT(RB_PARENT(elm, field), field)))                    \
        elm = RB_PARENT(elm, field);                                          \
      elm = RB_PARENT(elm, field);                                            \
    }                                                                         \
  }                                                                           \
  return (elm);                                                               \
}                                                                             \
                                                                              \
/* ARGSUSED */                                                                \
attr struct type *                                                            \
name##_RB_PREV(struct type *elm)                                              \
{                                                                             \
  if (RB_LEFT(elm, field)) {                                                  \
    elm = RB_LEFT(elm, field);                                                \
    while (RB_RIGHT(elm, field))                                              \
      elm = RB_RIGHT(elm, field);                                             \
  } else {                                                                    \
    if (RB_PARENT(elm, field) &&                                              \
        (elm == RB_RIGHT(RB_PARENT(elm, field), field)))                      \
      elm = RB_PARENT(elm, field);                                            \
    else {                                                                    \
      while (RB_PARENT(elm, field) &&                                         \
          (elm == RB_LEFT(RB_PARENT(elm, field), field)))                     \
        elm = RB_PARENT(elm, field);                                          \
      elm = RB_PARENT(elm, field);                                            \
    }                                                                         \
  }                                                                           \
  return (elm);                                                               \
}                                                                             \
                                                                              \
attr struct type *                                                            \
name##_RB_MINMAX(struct name *head, int val)                                  \
{                                                                             \
  struct type *tmp = RB_ROOT(head);                                           \
  struct type *parent = NULL;                                                 \
  while (tmp) {                                                               \
    parent = tmp;                                                             \
    if (val < 0)                                                              \
      tmp = RB_LEFT(tmp, field);                                              \
    else                                                                      \
      tmp = RB_RIGHT(tmp, field);                                             \
  }                                                                           \
  return (parent);                                                            \
}

#define RB_NEGINF   -1
#define RB_INF      1

#define RB_INSERT(name, x, y)   name##_RB_INSERT(x, y)
#define RB_REMOVE(name, x, y)   name##_RB_REMOVE(x, y)
#define RB_FIND(name, x, y)     name##_RB_FIND(x, y)
#define RB_NFIND(name, x, y)    name##_RB_NFIND(x, y)
#define RB_NEXT(name, x)        name##_RB_NEXT(x)
#define RB_PREV(name, x)        name##_RB_PREV(x)
#define RB_MIN(name, x)         name##_RB_MINMAX(x, RB_NEGINF)
#define RB_MAX(name, x)         name##_RB_MINMAX(x, RB_INF)

#define RB_FOREACH(x, name, head)                                             \
  for ((x) = RB_MIN(name, head);                                              \
       (x) != NULL;                                                           \
       (x) = name##_RB_NEXT(x))

#define RB_FOREACH_FROM(x, name, y)                                           \
  for ((x) = (y);                                                             \
      ((x) != NULL) && ((y) = name##_RB_NEXT(x), (x) != NULL);                \
       (x) = (y))

#define RB_FOREACH_SAFE(x, name, head, y)                                     \
  for ((x) = RB_MIN(name, head);                                              \
      ((x) != NULL) && ((y) = name##_RB_NEXT(x), (x) != NULL);                \
       (x) = (y))

#define RB_FOREACH_REVERSE(x, name, head)                                     \
  for ((x) = RB_MAX(name, head);                                              \
       (x) != NULL;                                                           \
       (x) = name##_RB_PREV(x))

#define RB_FOREACH_REVERSE_FROM(x, name, y)                                   \
  for ((x) = (y);                                                             \
      ((x) != NULL) && ((y) = name##_RB_PREV(x), (x) != NULL);                \
       (x) = (y))

#define RB_FOREACH_REVERSE_SAFE(x, name, head, y)                             \
  for ((x) = RB_MAX(name, head);                                              \
      ((x) != NULL) && ((y) = name##_RB_PREV(x), (x) != NULL);                \
       (x) = (y))

#endif  /* UV_TREE_H_ */
