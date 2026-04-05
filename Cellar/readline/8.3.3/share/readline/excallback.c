/*
From: Jeff Solomon <jsolomon@stanford.edu>
Date: Fri,  9 Apr 1999 10:13:27 -0700 (PDT)
To: chet@po.cwru.edu
Subject: new readline example
Message-ID: <14094.12094.527305.199695@mrclean.Stanford.EDU>

Chet,

I've been using readline 4.0. Specifically, I've been using the perl
version Term::ReadLine::Gnu. It works great.

Anyway, I've been playing around the alternate interface and I wanted
to contribute a little C program, callback.c, to you that you could
use as an example of the alternate interface in the /examples
directory of the readline distribution.

My example shows how, using the alternate interface, you can
interactively change the prompt (which is very nice imo). Also, I
point out that you must roll your own terminal setting when using the
alternate interface because readline depreps (using your parlance) the
terminal while in the user callback. I try to demonstrate what I mean
with an example. I've included the program below.

To compile, I just put the program in the examples directory and made
the appropriate changes to the EXECUTABLES and OBJECTS line and added
an additional target 'callback'.

I compiled on my Sun Solaris2.6 box using Sun's cc.

Let me know what you think.

Jeff
*/
/*
Copyright (C) 1999 Jeff Solomon
*/

#if defined (HAVE_CONFIG_H)
#include <config.h>
#endif

#include <sys/types.h>

#ifdef HAVE_UNISTD_H
#include <unistd.h>
#endif
#include <stdlib.h>

#include <stdio.h>
#include <termios.h>	/* xxx - should make this more general */

#include <locale.h>

#ifdef READLINE_LIBRARY
#  include "readline.h"
#  include "history.h"
#else
#  include <readline/readline.h>
#  include <readline/history.h>
#endif

#ifndef STDIN_FILENO
#  define STDIN_FILENO 0
#endif

/* This little examples demonstrates the alternate interface to using readline.
 * In the alternate interface, the user maintains control over program flow and
 * only calls readline when STDIN is readable. Using the alternate interface,
 * you can do anything else while still using readline (like talking to a
 * network or another program) without blocking.
 *
 * Specifically, this program highlights two importants features of the
 * alternate interface. The first is the ability to interactively change the
 * prompt, which can't be done using the regular interface since rl_prompt is
 * read-only.
 *
 * The second feature really highlights a subtle point when using the alternate
 * interface. That is, readline will not alter the terminal when inside your
 * callback handler. So let's so, your callback executes a user command that
 * takes a non-trivial amount of time to complete (seconds). While your
 * executing the command, the user continues to type keystrokes and expects them
 * to be re-echoed on the new prompt when it returns. Unfortunately, the default
 * terminal configuration doesn't do this. After the prompt returns, the user
 * must hit one additional keystroke and then will see all of his previous
 * keystrokes. To illustrate this, compile and run this program. Type "sleep" at
 * the prompt and then type "bar" before the prompt returns (you have 3
 * seconds). Notice how "bar" is re-echoed on the prompt after the prompt
 * returns? This is what you expect to happen. Now comment out the 4 lines below
 * the line that says COMMENT LINE BELOW. Recompile and rerun the program and do
 * the same thing. When the prompt returns, you should not see "bar". Now type
 * "f", see how "barf" magically appears? This behavior is un-expected and not
 * desired.
 */

void process_line(char *line);
int  change_prompt(int, int);
char *get_prompt(void);

int prompt = 1;
char prompt_buf[40], line_buf[256];
tcflag_t old_lflag;
cc_t     old_vtime;
struct termios term;

int
main(int c, char **v)
{
    fd_set fds;

    setlocale (LC_ALL, "");

    /* Adjust the terminal slightly before the handler is installed. Disable
     * canonical mode processing and set the input character time flag to be
     * non-blocking.
     */
    if( tcgetattr(STDIN_FILENO, &term) < 0 ) {
        perror("tcgetattr");
        exit(1);
    }
    old_lflag = term.c_lflag;
    old_vtime = term.c_cc[VTIME];
    term.c_lflag &= ~ICANON;
    term.c_cc[VTIME] = 1;
    /* COMMENT LINE BELOW - see above */
    if( tcsetattr(STDIN_FILENO, TCSANOW, &term) < 0 ) {
        perror("tcsetattr");
        exit(1);
    }

    rl_add_defun("change-prompt", change_prompt, CTRL('t'));
    rl_callback_handler_install(get_prompt(), process_line);

    while(1) {
      FD_ZERO(&fds);
      FD_SET(fileno(stdin), &fds);

      if( select(FD_SETSIZE, &fds, NULL, NULL, NULL) < 0) {
        perror("select");
        exit(1);
      }

      if( FD_ISSET(fileno(stdin), &fds) ) {
        rl_callback_read_char();
      }
    }
}

void
process_line(char *line)
{
  if( line == NULL ) {
    fprintf(stderr, "\n", line);

    /* reset the old terminal setting before exiting */
    term.c_lflag     = old_lflag;
    term.c_cc[VTIME] = old_vtime;
    if( tcsetattr(STDIN_FILENO, TCSANOW, &term) < 0 ) {
        perror("tcsetattr");
        exit(1);
    }
    exit(0);
  }

  if( strcmp(line, "sleep") == 0 ) {
    sleep(3);
  } else {
    fprintf(stderr, "|%s|\n", line);
  }

  free (line);
}

int
change_prompt(int count, int key)
{
  /* toggle the prompt variable */
  prompt = !prompt;

  rl_set_prompt (get_prompt ());
  return 0;
}

char *
get_prompt(void)
{
  /* The prompts can even be different lengths! */
  sprintf(prompt_buf, "%s",
    prompt ? "Hit ctrl-t to toggle prompt> " : "Pretty cool huh?> ");
  return prompt_buf;
}
