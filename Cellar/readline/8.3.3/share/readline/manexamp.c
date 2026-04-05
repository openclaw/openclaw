/* manexamp.c -- The examples which appear in the documentation are here. */

/* Copyright (C) 1987-2009,2023 Free Software Foundation, Inc.

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
#if defined (HAVE_CONFIG_H)
#  include <config.h>
#endif

#ifdef HAVE_UNISTD_H
#  include <unistd.h>
#endif


#include <stdlib.h>
#include <stdio.h>

#include <ctype.h>
#include <string.h>
#include <errno.h>
   
#include <locale.h>

#ifndef errno
extern int errno;
#endif

#if defined (READLINE_LIBRARY)
#  include "readline.h"
#  include "history.h"
#else
#  include <readline/readline.h>
#  include <readline/history.h>
#endif

/* **************************************************************** */
/*                                                                  */
/*   			How to Emulate gets ()			    */
/*                                                                  */
/* **************************************************************** */

/* A static variable for holding the line. */
static char *line_read = (char *)NULL;

/* Read a string, and return a pointer to it.  Returns NULL on EOF. */
char *
rl_gets (void)
{
  /* If the buffer has already been allocated, return the memory
     to the free pool. */
  if (line_read)
    {
      free (line_read);
      line_read = (char *)NULL;
    }

  /* Get a line from the user. */
  line_read = readline ("");

  /* If the line has any text in it, save it on the history. */
  if (line_read && *line_read)
    add_history (line_read);

  return (line_read);
}

/* **************************************************************** */
/*                                                                  */
/*        Writing a Function to be Called by Readline.              */
/*                                                                  */
/* **************************************************************** */

/* Invert the case of the COUNT following characters. */
int
invert_case_line (int count, int key)
{
  int start, end;
  int direction;

  start = rl_point;

  /* Find the end of the range to modify. */
  end = start + count;

  /* Force it to be within range. */
  if (end > rl_end)
    end = rl_end;
  else if (end < 0)
    end = -1;

  if (start == end)
    return 0;

  /* For positive arguments, put point after the last changed character. For
     negative arguments, put point before the last changed character. */
  rl_point = end;

  /* Swap start and end if we are moving backwards */
  if (start > end)
    {
      int temp = start;
      start = end;
      end = temp;
    }

  /* Tell readline that we are modifying the line, so save the undo
     information. */
  rl_modifying (start, end);

  for (; start != end; start++)
    {
      if (_rl_uppercase_p (rl_line_buffer[start]))
	rl_line_buffer[start] = _rl_to_lower (rl_line_buffer[start]);
      else if (_rl_lowercase_p (rl_line_buffer[start]))
	rl_line_buffer[start] = _rl_to_upper (rl_line_buffer[start]);
    }

  return 0;
}
