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

/*
 *  \file SDL_test_common.h
 *
 *  Include file for SDL test framework.
 *
 *  This code is a part of the SDL2_test library, not the main SDL library.
 */

/* Ported from original test\common.h file. */

#ifndef SDL_test_common_h_
#define SDL_test_common_h_

#include "SDL.h"

#if defined(__PSP__)
#define DEFAULT_WINDOW_WIDTH  480
#define DEFAULT_WINDOW_HEIGHT 272
#elif defined(__VITA__)
#define DEFAULT_WINDOW_WIDTH  960
#define DEFAULT_WINDOW_HEIGHT 544
#else
#define DEFAULT_WINDOW_WIDTH  640
#define DEFAULT_WINDOW_HEIGHT 480
#endif

#define VERBOSE_VIDEO   0x00000001
#define VERBOSE_MODES   0x00000002
#define VERBOSE_RENDER  0x00000004
#define VERBOSE_EVENT   0x00000008
#define VERBOSE_AUDIO   0x00000010
#define VERBOSE_MOTION  0x00000020

typedef struct
{
    /* SDL init flags */
    char **argv;
    Uint32 flags;
    Uint32 verbose;

    /* Video info */
    const char *videodriver;
    int display;
    const char *window_title;
    const char *window_icon;
    Uint32 window_flags;
    SDL_bool flash_on_focus_loss;
    int window_x;
    int window_y;
    int window_w;
    int window_h;
    int window_minW;
    int window_minH;
    int window_maxW;
    int window_maxH;
    int logical_w;
    int logical_h;
    float scale;
    int depth;
    int refresh_rate;
    int num_windows;
    SDL_Window **windows;

    /* Renderer info */
    const char *renderdriver;
    Uint32 render_flags;
    SDL_bool skip_renderer;
    SDL_Renderer **renderers;
    SDL_Texture **targets;

    /* Audio info */
    const char *audiodriver;
    SDL_AudioSpec audiospec;

    /* GL settings */
    int gl_red_size;
    int gl_green_size;
    int gl_blue_size;
    int gl_alpha_size;
    int gl_buffer_size;
    int gl_depth_size;
    int gl_stencil_size;
    int gl_double_buffer;
    int gl_accum_red_size;
    int gl_accum_green_size;
    int gl_accum_blue_size;
    int gl_accum_alpha_size;
    int gl_stereo;
    int gl_multisamplebuffers;
    int gl_multisamplesamples;
    int gl_retained_backing;
    int gl_accelerated;
    int gl_major_version;
    int gl_minor_version;
    int gl_debug;
    int gl_profile_mask;

    /* Additional fields added in 2.0.18 */
    SDL_Rect confine;

} SDLTest_CommonState;

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/* Function prototypes */

/*
 * \brief Parse command line parameters and create common state.
 *
 * \param argv Array of command line parameters
 * \param flags Flags indicating which subsystem to initialize (i.e. SDL_INIT_VIDEO | SDL_INIT_AUDIO)
 *
 * \returns a newly allocated common state object.
 */
SDLTest_CommonState *SDLTest_CommonCreateState(char **argv, Uint32 flags);

/*
 * \brief Process one common argument.
 *
 * \param state The common state describing the test window to create.
 * \param index The index of the argument to process in argv[].
 *
 * \returns the number of arguments processed (i.e. 1 for --fullscreen, 2 for --video [videodriver], or -1 on error.
 */
int SDLTest_CommonArg(SDLTest_CommonState * state, int index);


/*
 * \brief Logs command line usage info.
 *
 * This logs the appropriate command line options for the subsystems in use
 *  plus other common options, and then any application-specific options.
 *  This uses the SDL_Log() function and splits up output to be friendly to
 *  80-character-wide terminals.
 *
 * \param state The common state describing the test window for the app.
 * \param argv0 argv[0], as passed to main/SDL_main.
 * \param options an array of strings for application specific options. The last element of the array should be NULL.
 */
void SDLTest_CommonLogUsage(SDLTest_CommonState * state, const char *argv0, const char **options);

/*
 * \brief Returns common usage information
 *
 * You should (probably) be using SDLTest_CommonLogUsage() instead, but this
 *  function remains for binary compatibility. Strings returned from this
 *  function are valid until SDLTest_CommonQuit() is called, in which case
 *  those strings' memory is freed and can no longer be used.
 *
 * \param state The common state describing the test window to create.
 * \returns a string with usage information
 */
const char *SDLTest_CommonUsage(SDLTest_CommonState * state);

/*
 * \brief Open test window.
 *
 * \param state The common state describing the test window to create.
 *
 * \returns SDL_TRUE if initialization succeeded, false otherwise
 */
SDL_bool SDLTest_CommonInit(SDLTest_CommonState * state);

/*
 * \brief Easy argument handling when test app doesn't need any custom args.
 *
 * \param state The common state describing the test window to create.
 * \param argc argc, as supplied to SDL_main
 * \param argv argv, as supplied to SDL_main
 *
 * \returns SDL_FALSE if app should quit, true otherwise.
 */
SDL_bool SDLTest_CommonDefaultArgs(SDLTest_CommonState * state, const int argc, char **argv);

/*
 * \brief Common event handler for test windows.
 *
 * \param state The common state used to create test window.
 * \param event The event to handle.
 * \param done Flag indicating we are done.
 *
 */
void SDLTest_CommonEvent(SDLTest_CommonState * state, SDL_Event * event, int *done);

/*
 * \brief Close test window.
 *
 * \param state The common state used to create test window.
 *
 */
void SDLTest_CommonQuit(SDLTest_CommonState * state);

/*
 * \brief Draws various window information (position, size, etc.) to the renderer.
 *
 * \param renderer The renderer to draw to.
 * \param window The window whose information should be displayed.
 * \param usedHeight Returns the height used, so the caller can draw more below.
 *
 */
void SDLTest_CommonDrawWindowInfo(SDL_Renderer * renderer, SDL_Window * window, int * usedHeight);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_test_common_h_ */

/* vi: set ts=4 sw=4 expandtab: */
