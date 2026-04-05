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
 * # CategoryQuit
 *
 * An SDL_QUIT event is generated when the user tries to close the application
 * window. If it is ignored or filtered out, the window will remain open. If
 * it is not ignored or filtered, it is queued normally and the window is
 * allowed to close. When the window is closed, screen updates will complete,
 * but have no effect.
 *
 * SDL_Init() installs signal handlers for SIGINT (keyboard interrupt) and
 * SIGTERM (system termination request), if handlers do not already exist,
 * that generate SDL_QUIT events as well. There is no way to determine the
 * cause of an SDL_QUIT event, but setting a signal handler in your
 * application will override the default generation of quit events for that
 * signal.
 */

#ifndef SDL_quit_h_
#define SDL_quit_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"

/* There are no functions directly affecting the quit event */

#define SDL_QuitRequested() \
        (SDL_PumpEvents(), (SDL_PeepEvents(NULL,0,SDL_PEEKEVENT,SDL_QUIT,SDL_QUIT) > 0))

#endif /* SDL_quit_h_ */
