/*
  Simple DirectMedia Layer
  Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.
*/

/**
 * # CategoryRect
 *
 * Header file for SDL_rect definition and management functions.
 */

#ifndef SDL_rect_h_
#define SDL_rect_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"
#include "SDL_pixels.h"
#include "SDL_rwops.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/**
 * The structure that defines a point (integer)
 *
 * \sa SDL_EnclosePoints
 * \sa SDL_PointInRect
 */
typedef struct SDL_Point
{
    int x;
    int y;
} SDL_Point;

/**
 * The structure that defines a point (floating point)
 *
 * \sa SDL_EncloseFPoints
 * \sa SDL_PointInFRect
 */
typedef struct SDL_FPoint
{
    float x;
    float y;
} SDL_FPoint;


/**
 * A rectangle, with the origin at the upper left (integer).
 *
 * \sa SDL_RectEmpty
 * \sa SDL_RectEquals
 * \sa SDL_HasIntersection
 * \sa SDL_IntersectRect
 * \sa SDL_IntersectRectAndLine
 * \sa SDL_UnionRect
 * \sa SDL_EnclosePoints
 */
typedef struct SDL_Rect
{
    int x, y;
    int w, h;
} SDL_Rect;


/**
 * A rectangle, with the origin at the upper left (floating point).
 *
 * \sa SDL_FRectEmpty
 * \sa SDL_FRectEquals
 * \sa SDL_FRectEqualsEpsilon
 * \sa SDL_HasIntersectionF
 * \sa SDL_IntersectFRect
 * \sa SDL_IntersectFRectAndLine
 * \sa SDL_UnionFRect
 * \sa SDL_EncloseFPoints
 * \sa SDL_PointInFRect
 */
typedef struct SDL_FRect
{
    float x;
    float y;
    float w;
    float h;
} SDL_FRect;


/**
 * Returns true if point resides inside a rectangle.
 */
SDL_FORCE_INLINE SDL_bool SDL_PointInRect(const SDL_Point *p, const SDL_Rect *r)
{
    return ( (p->x >= r->x) && (p->x < (r->x + r->w)) &&
             (p->y >= r->y) && (p->y < (r->y + r->h)) ) ? SDL_TRUE : SDL_FALSE;
}

/**
 * Returns true if the rectangle has no area.
 */
SDL_FORCE_INLINE SDL_bool SDL_RectEmpty(const SDL_Rect *r)
{
    return ((!r) || (r->w <= 0) || (r->h <= 0)) ? SDL_TRUE : SDL_FALSE;
}

/**
 * Returns true if the two rectangles are equal.
 */
SDL_FORCE_INLINE SDL_bool SDL_RectEquals(const SDL_Rect *a, const SDL_Rect *b)
{
    return (a && b && (a->x == b->x) && (a->y == b->y) &&
            (a->w == b->w) && (a->h == b->h)) ? SDL_TRUE : SDL_FALSE;
}

/**
 * Determine whether two rectangles intersect.
 *
 * If either pointer is NULL the function will return SDL_FALSE.
 *
 * \param A an SDL_Rect structure representing the first rectangle.
 * \param B an SDL_Rect structure representing the second rectangle.
 * \returns SDL_TRUE if there is an intersection, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_IntersectRect
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasIntersection(const SDL_Rect * A,
                                                     const SDL_Rect * B);

/**
 * Calculate the intersection of two rectangles.
 *
 * If `result` is NULL then this function will return SDL_FALSE.
 *
 * \param A an SDL_Rect structure representing the first rectangle.
 * \param B an SDL_Rect structure representing the second rectangle.
 * \param result an SDL_Rect structure filled in with the intersection of
 *               rectangles `A` and `B`.
 * \returns SDL_TRUE if there is an intersection, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HasIntersection
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IntersectRect(const SDL_Rect * A,
                                                   const SDL_Rect * B,
                                                   SDL_Rect * result);

/**
 * Calculate the union of two rectangles.
 *
 * \param A an SDL_Rect structure representing the first rectangle.
 * \param B an SDL_Rect structure representing the second rectangle.
 * \param result an SDL_Rect structure filled in with the union of rectangles
 *               `A` and `B`.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC void SDLCALL SDL_UnionRect(const SDL_Rect * A,
                                           const SDL_Rect * B,
                                           SDL_Rect * result);

/**
 * Calculate a minimal rectangle enclosing a set of points.
 *
 * If `clip` is not NULL then only points inside of the clipping rectangle are
 * considered.
 *
 * \param points an array of SDL_Point structures representing points to be
 *               enclosed.
 * \param count the number of structures in the `points` array.
 * \param clip an SDL_Rect used for clipping or NULL to enclose all points.
 * \param result an SDL_Rect structure filled in with the minimal enclosing
 *               rectangle.
 * \returns SDL_TRUE if any points were enclosed or SDL_FALSE if all the
 *          points were outside of the clipping rectangle.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_EnclosePoints(const SDL_Point * points,
                                                   int count,
                                                   const SDL_Rect * clip,
                                                   SDL_Rect * result);

/**
 * Calculate the intersection of a rectangle and line segment.
 *
 * This function is used to clip a line segment to a rectangle. A line segment
 * contained entirely within the rectangle or that does not intersect will
 * remain unchanged. A line segment that crosses the rectangle at either or
 * both ends will be clipped to the boundary of the rectangle and the new
 * coordinates saved in `X1`, `Y1`, `X2`, and/or `Y2` as necessary.
 *
 * \param rect an SDL_Rect structure representing the rectangle to intersect.
 * \param X1 a pointer to the starting X-coordinate of the line.
 * \param Y1 a pointer to the starting Y-coordinate of the line.
 * \param X2 a pointer to the ending X-coordinate of the line.
 * \param Y2 a pointer to the ending Y-coordinate of the line.
 * \returns SDL_TRUE if there is an intersection, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IntersectRectAndLine(const SDL_Rect *
                                                          rect, int *X1,
                                                          int *Y1, int *X2,
                                                          int *Y2);


/* SDL_FRect versions... */

/**
 * Returns true if point resides inside a rectangle.
 */
SDL_FORCE_INLINE SDL_bool SDL_PointInFRect(const SDL_FPoint *p, const SDL_FRect *r)
{
    return ( (p->x >= r->x) && (p->x < (r->x + r->w)) &&
             (p->y >= r->y) && (p->y < (r->y + r->h)) ) ? SDL_TRUE : SDL_FALSE;
}

/**
 * Returns true if the rectangle has no area.
 */
SDL_FORCE_INLINE SDL_bool SDL_FRectEmpty(const SDL_FRect *r)
{
    return ((!r) || (r->w <= 0.0f) || (r->h <= 0.0f)) ? SDL_TRUE : SDL_FALSE;
}

/**
 * Returns true if the two rectangles are equal, within some given epsilon.
 *
 * \since This function is available since SDL 2.0.22.
 */
SDL_FORCE_INLINE SDL_bool SDL_FRectEqualsEpsilon(const SDL_FRect *a, const SDL_FRect *b, const float epsilon)
{
    return (a && b && ((a == b) ||
            ((SDL_fabsf(a->x - b->x) <= epsilon) &&
            (SDL_fabsf(a->y - b->y) <= epsilon) &&
            (SDL_fabsf(a->w - b->w) <= epsilon) &&
            (SDL_fabsf(a->h - b->h) <= epsilon))))
            ? SDL_TRUE : SDL_FALSE;
}

/**
 * Returns true if the two rectangles are equal, using a default epsilon.
 *
 * \since This function is available since SDL 2.0.22.
 */
SDL_FORCE_INLINE SDL_bool SDL_FRectEquals(const SDL_FRect *a, const SDL_FRect *b)
{
    return SDL_FRectEqualsEpsilon(a, b, SDL_FLT_EPSILON);
}

/**
 * Determine whether two rectangles intersect with float precision.
 *
 * If either pointer is NULL the function will return SDL_FALSE.
 *
 * \param A an SDL_FRect structure representing the first rectangle.
 * \param B an SDL_FRect structure representing the second rectangle.
 * \returns SDL_TRUE if there is an intersection, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.22.
 *
 * \sa SDL_IntersectRect
 */
extern DECLSPEC SDL_bool SDLCALL SDL_HasIntersectionF(const SDL_FRect * A,
                                                      const SDL_FRect * B);

/**
 * Calculate the intersection of two rectangles with float precision.
 *
 * If `result` is NULL then this function will return SDL_FALSE.
 *
 * \param A an SDL_FRect structure representing the first rectangle.
 * \param B an SDL_FRect structure representing the second rectangle.
 * \param result an SDL_FRect structure filled in with the intersection of
 *               rectangles `A` and `B`.
 * \returns SDL_TRUE if there is an intersection, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.22.
 *
 * \sa SDL_HasIntersectionF
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IntersectFRect(const SDL_FRect * A,
                                                    const SDL_FRect * B,
                                                    SDL_FRect * result);

/**
 * Calculate the union of two rectangles with float precision.
 *
 * \param A an SDL_FRect structure representing the first rectangle.
 * \param B an SDL_FRect structure representing the second rectangle.
 * \param result an SDL_FRect structure filled in with the union of rectangles
 *               `A` and `B`.
 *
 * \since This function is available since SDL 2.0.22.
 */
extern DECLSPEC void SDLCALL SDL_UnionFRect(const SDL_FRect * A,
                                            const SDL_FRect * B,
                                            SDL_FRect * result);

/**
 * Calculate a minimal rectangle enclosing a set of points with float
 * precision.
 *
 * If `clip` is not NULL then only points inside of the clipping rectangle are
 * considered.
 *
 * \param points an array of SDL_FPoint structures representing points to be
 *               enclosed.
 * \param count the number of structures in the `points` array.
 * \param clip an SDL_FRect used for clipping or NULL to enclose all points.
 * \param result an SDL_FRect structure filled in with the minimal enclosing
 *               rectangle.
 * \returns SDL_TRUE if any points were enclosed or SDL_FALSE if all the
 *          points were outside of the clipping rectangle.
 *
 * \since This function is available since SDL 2.0.22.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_EncloseFPoints(const SDL_FPoint * points,
                                                    int count,
                                                    const SDL_FRect * clip,
                                                    SDL_FRect * result);

/**
 * Calculate the intersection of a rectangle and line segment with float
 * precision.
 *
 * This function is used to clip a line segment to a rectangle. A line segment
 * contained entirely within the rectangle or that does not intersect will
 * remain unchanged. A line segment that crosses the rectangle at either or
 * both ends will be clipped to the boundary of the rectangle and the new
 * coordinates saved in `X1`, `Y1`, `X2`, and/or `Y2` as necessary.
 *
 * \param rect an SDL_FRect structure representing the rectangle to intersect.
 * \param X1 a pointer to the starting X-coordinate of the line.
 * \param Y1 a pointer to the starting Y-coordinate of the line.
 * \param X2 a pointer to the ending X-coordinate of the line.
 * \param Y2 a pointer to the ending Y-coordinate of the line.
 * \returns SDL_TRUE if there is an intersection, SDL_FALSE otherwise.
 *
 * \since This function is available since SDL 2.0.22.
 */
extern DECLSPEC SDL_bool SDLCALL SDL_IntersectFRectAndLine(const SDL_FRect *
                                                           rect, float *X1,
                                                           float *Y1, float *X2,
                                                           float *Y2);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_rect_h_ */

/* vi: set ts=4 sw=4 expandtab: */
