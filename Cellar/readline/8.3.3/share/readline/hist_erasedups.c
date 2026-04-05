/* hist_erasedups -- remove all duplicate entries from history file */

/* Copyright (C) 2011,2023 Free Software Foundation, Inc.

   This file is part of the GNU Readline Library (Readline), a library for
   reading lines of text with interactive input and history editing.

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
#ifndef READLINE_LIBRARY
#define READLINE_LIBRARY 1
#endif

#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>

#ifdef READLINE_LIBRARY
#  include "history.h"
#else
#  include <readline/history.h>
#endif

#include <string.h>

#define STREQ(a, b) ((a)[0] == (b)[0] && strcmp(a, b) == 0)
#define STREQN(a, b, n) ((n == 0) ? (1) \
                                  : ((a)[0] == (b)[0] && strncmp(a, b, n) == 0))

int hist_erasedups (void);

static void
usage(void)
{
  fprintf (stderr, "hist_erasedups: usage: hist_erasedups [-t] [filename]\n");
  exit (2);
}

int
main (int argc, char **argv)
{
  char *fn;
  int r;

  while ((r = getopt (argc, argv, "t")) != -1)
    {
      switch (r)
	{
	case 't':
	  history_write_timestamps = 1;
	  break;
	default:
	  usage ();
	}
    }
  argv += optind;
  argc -= optind;

  fn = argc ? argv[0] : getenv ("HISTFILE");
  if (fn == 0)
    {
      fprintf (stderr, "hist_erasedups: no history file\n");
      usage ();
    }

  if ((r = read_history (fn)) != 0)
    {
      fprintf (stderr, "hist_erasedups: read_history: %s: %s\n", fn, strerror (r));
      exit (1);
    }

  hist_erasedups ();

  if ((r = write_history (fn)) != 0)
    {
      fprintf (stderr, "hist_erasedups: write_history: %s: %s\n", fn, strerror (r));
      exit (1);
    }

  exit (0);
}

int
hist_erasedups (void)
{
  int r, n;
  HIST_ENTRY *h, *temp;

  using_history ();
  while (h = previous_history ())
    {
      r = where_history ();
      for (n = 0; n < r; n++)
	{
	  temp = history_get (n+history_base);
	  if (STREQ (h->line, temp->line))
	    {
	      remove_history (n);
	      r--;			/* have to get one fewer now */
	      n--;			/* compensate for above increment */
	      history_offset--;		/* moving backwards in history list */
	    }
	}
    }
  using_history ();

  return r;
}
