/* rlconf.h -- readline configuration definitions */

/* Copyright (C) 1992-2015 Free Software Foundation, Inc.

   This file is part of the GNU Readline Library (Readline), a library
   for reading lines of text with interactive input and history editing.      

   Readline is free software: you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   Readline is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with Readline.  If not, see <http://www.gnu.org/licenses/>.
*/

#if !defined (_RLCONF_H_)
#define _RLCONF_H_

/* Define this if you want the vi-mode editing available. */
#define VI_MODE

/* Define this to get an indication of file type when listing completions. */
#define VISIBLE_STATS

/* Define this to get support for colors when listing completions and in
   other places. */
#define COLOR_SUPPORT

/* This definition is needed by readline.c, rltty.c, and signals.c. */
/* If on, then readline handles signals in a way that doesn't suck. */
#define HANDLE_SIGNALS

/* Ugly but working hack for binding prefix meta. */
#define PREFIX_META_HACK

/* The next-to-last-ditch effort file name for a user-specific init file. */
#define DEFAULT_INPUTRC "~/.inputrc"

/* The ultimate last-ditch filename for an init file -- system-wide. */
#define SYS_INPUTRC "/etc/inputrc"

/* If defined, expand tabs to spaces. */
#define DISPLAY_TABS

/* If defined, use the terminal escape sequence to move the cursor forward
   over a character when updating the line rather than rewriting it. */
/* #define HACK_TERMCAP_MOTION */

/* The string inserted by the `insert comment' command. */
#define RL_COMMENT_BEGIN_DEFAULT "#"

/* Define this if you want code that allows readline to be used in an
   X `callback' style. */
#define READLINE_CALLBACKS

/* Define this if you want the cursor to indicate insert or overwrite mode. */
/* #define CURSOR_MODE */

/* Define this if you want to enable code that talks to the Linux kernel
   tty auditing system. */
/* #define ENABLE_TTY_AUDIT_SUPPORT */

/* Defaults for the various editing mode indicators, inserted at the beginning
   of the last (maybe only) line of the prompt if show-mode-in-prompt is on */
#define RL_EMACS_MODESTR_DEFAULT	"@"
#define RL_EMACS_MODESTR_DEFLEN		1

#define RL_VI_INS_MODESTR_DEFAULT	"(ins)"
#define RL_VI_INS_MODESTR_DEFLEN	5
#define RL_VI_CMD_MODESTR_DEFAULT	"(cmd)"
#define RL_VI_CMD_MODESTR_DEFLEN	5

/* Do you want readline to assume it's running in an ANSI-compatible terminal
   by default? If set to 0, readline tries to check and verify whether or not
   it is. */
#define RL_ANSI_TERM_DEFAULT	1	/* for now */

#endif /* _RLCONF_H_ */
