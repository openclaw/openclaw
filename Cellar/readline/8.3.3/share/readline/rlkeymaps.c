#include <stdlib.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

#if defined (READLINE_LIBRARY)
#  include "readline.h"
#  include "history.h"
#else
#  include <readline/readline.h>
#  include <readline/history.h>
#endif

int
main (int c, char **v)
{
  Keymap nmap, emacsmap, newemacs;
  int r, errs;

  errs = 0;
  nmap = rl_make_keymap ();

  r = rl_set_keymap_name ("emacs", nmap);
  if (r >= 0)
    {
      fprintf (stderr, "rlkeymaps: error: able to rename `emacs' keymap\n");
      errs++;
    }

  emacsmap = rl_get_keymap_by_name ("emacs");
  r = rl_set_keymap_name ("newemacs", emacsmap);
  if (r >= 0)
    {
      fprintf (stderr, "rlkeymaps: error: able to set new name for emacs keymap\n");
      errs++;
    }

  r = rl_set_keymap_name ("newemacs", nmap);
  if (r < 0)
    {
      fprintf (stderr, "rlkeymaps: error: newemacs: could not set keymap name\n");
      errs++;
    }

  newemacs = rl_copy_keymap (emacsmap);
  r = rl_set_keymap_name ("newemacs", newemacs);
  if (r < 0)
    {
      fprintf (stderr, "rlkeymaps: error: newemacs: could not set `newemacs' keymap to new map\n");
      errs++;
    }

  r = rl_set_keymap_name ("emacscopy", newemacs);
  if (r < 0)
    {
      fprintf (stderr, "rlkeymaps: error: emacscopy: could not rename created keymap\n");
      errs++;
    }

  exit (errs);
}
