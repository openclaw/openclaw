:: Word filter hook: blocks posts containing banned words
:: Config: words (comma-separated list of words to block)
::
|=  [=event:h =bowl:h]
^-  outcome:h
|^
::  Only filter new posts
?.  ?=([%on-post %add *] event)
  &+[[[%allowed event] ~] state.hook.bowl]
::  Get banned words from config (comma-separated)
=+  ;;(words-cord=cord (~(gut by config.bowl) 'words' ''))
::  Skip if no words configured
?:  =('' words-cord)
  &+[[[%allowed event] ~] state.hook.bowl]
::  Split on commas into list of tapes
=/  banned=(list tape)
  (split-on-comma (trip words-cord))
::  Get message content
=/  content=tape  (extract-text content.post.event)
::  Check if any banned word appears in content
=/  has-banned=?
  %+  lien  banned
  |=  word=tape
  !=(~ (find word content))
::  If found, deny
?:  has-banned
  &+[[[%denied `'Message contains prohibited content'] ~] state.hook.bowl]
::  Otherwise allow
&+[[[%allowed event] ~] state.hook.bowl]
::
++  split-on-comma
  |=  txt=tape
  ^-  (list tape)
  =/  idx  (find "," txt)
  ?~  idx
    ?~  txt  *(list tape)
    ~[txt]
  :-  (scag u.idx txt)
  $(txt (slag +(u.idx) txt))
::
++  extract-text
  |=  =story:c
  ^-  tape
  ?~  story  ""
  =/  verse  i.story
  ?.  ?=(%inline -.verse)  ""
  ?~  p.verse  ""
  =/  inl  i.p.verse
  ?@  inl
    (trip inl)
  ""
--
