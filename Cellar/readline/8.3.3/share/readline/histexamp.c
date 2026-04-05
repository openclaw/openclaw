/* histexamp.c - history library example program. */

/* Copyright (C) 1987-2009 Free Software Foundation, Inc.

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

#include <stdio.h>

#ifdef READLINE_LIBRARY
#  include "history.h"
#else
#  include <readline/history.h>
#endif

#include <unistd.h>
#include <stdlib.h>
#include <string.h>

int
main (int argc, char **argv)
{
  char line[1024], *t;
  int len, done;

  line[0] = 0;
  done = 0;

  using_history ();
  while (!done)
    {
      printf ("history$ ");
      fflush (stdout);
      t = fgets (line, sizeof (line) - 1, stdin);
      if (t && *t)
	{
	  len = strlen (t);
	  if (t[len - 1] == '\n')
	    t[len - 1] = '\0';
	}

      if (!t)
	strcpy (line, "quit");

      if (line[0])
	{
	  char *expansion;
	  int result;

	  using_history ();

	  result = history_expand (line, &expansion);
	  if (result)
	    fprintf (stderr, "%s\n", expansion);

	  if (result < 0 || result == 2)
	    {
	      free (expansion);
	      continue;
	    }

	  add_history (expansion);
	  strncpy (line, expansion, sizeof (line) - 1);
	  free (expansion);
	}

      if (strcmp (line, "quit") == 0)
	done = 1;
      else if (strcmp (line, "save") == 0)
	write_history ("history_file");
      else if (strcmp (line, "read") == 0)
	read_history ("history_file");
      else if (strcmp (line, "list") == 0)
	{
	  register HIST_ENTRY **the_list;
	  register int i;
	  time_t tt;
	  struct tm *tm;
	  char timestr[128];

	  the_list = history_list ();
	  if (the_list)
	    for (i = 0; the_list[i]; i++)
	      {
	      	tt = history_get_time (the_list[i]);
	      	tm = tt ? localtime (&tt) : 0;
		if (tm)
		  strftime (timestr, sizeof (timestr), "%a %R", tm);
		else
		  strcpy (timestr, "??");
	        printf ("%d: %s: %s\n", i + history_base, timestr, the_list[i]->line);
	      }
	}
      else if (strncmp (line, "delete", 6) == 0)
	{
	  int which;
	  if ((sscanf (line + 6, "%d", &which)) == 1)
	    {
	      HIST_ENTRY *entry = remove_history (which - history_base);
	      if (!entry)
		fprintf (stderr, "No such entry %d\n", which);
	      else
		{
		  free (entry->line);
		  free (entry);
		}
	    }
	  else
	    {
	      fprintf (stderr, "non-numeric arg given to `delete'\n");
	    }
	}
    }
}
